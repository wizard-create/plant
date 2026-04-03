class Predictor{
  constructor(db){
    this.db=db;
  }

  //获取过去72小时的数据
  async getHistory(deviceId,hours){
    return await this.db.operate(`
      SELECT 
        UNIX_TIMESTAMP(created_time) as timestamp,
        created_time,
        moisture 
      FROM sensor_data 
      WHERE device_id=? 
        AND created_time>=DATE_SUB(NOW(),INTERVAL ? HOUR)
        AND moisture IS NOT NULL
      ORDER BY created_time ASC`,
      [deviceId,hours]);
  }

  //判断浇水事件
  async getValidHistoryData(deviceId,hours){
    //获取原始历史数据
    const rawData=await this.getHistory(deviceId,hours);
    if(rawData.length<10) return rawData;
  
    //从最新往旧扫描，找到最后一次浇水事件
    let lastWatering=-1;
    for(let i=rawData.length-1;i>=1;i--){
        const current=rawData[i].moisture;
        const previous=rawData[i-1].moisture;
        if(previous===0) continue;//防止除数为零
        const increasePercent=((current-previous)/previous)*100;
        if(increasePercent>=20){
        lastWatering=i;
        break;
        }
    }
  
    //如果检测到浇水，只使用浇水之后的数据
    if(lastWatering!==-1){
        const validData=rawData.slice(lastWatering);
        return validData;
    }
  
    //没有浇水事件，使用全部数据
    return rawData;
  }

  //线性回归预测（默认预测未来24小时）
  firstPredict(data){
    const n=data.length;

    //x（时间戳，从第一个点开始，单位为小时）和y（湿度值）
    const timestamps=data.map(d=>d.timestamp);
    const y=data.map(d=>d.moisture);
    const x=timestamps.map(t=>(t-timestamps[0])/3600);

    //利用最小二乘法计算斜率（每小时变化率）
    let sumX=0,sumY=0,sumXY=0,sumXX=0;
    for(let i=0;i<n;i++){
      sumX+=x[i];
      sumY+=y[i];
      sumXY+=x[i]*y[i];
      sumXX+=x[i]*x[i];
    }
    const k=(n*sumXY-sumX*sumY)/(n*sumXX-sumX*sumX);
    
    return k;
  }

  //指数平滑预测
  secondPredict(data,alpha){
    const n=data.length;
    
    const timestamps=data.map(d=>d.timestamp);
    const y=data.map(d=>d.moisture);
    const x=timestamps.map(t=>(t-timestamps[0])/3600);
    
    //指数平滑算法
    let smoothed=[y[0]];
    for(let i=1;i<n;i++){
      smoothed.push(alpha*y[i]+(1-alpha)*smoothed[i-1]);
    }
    
    //计算趋势（最近十个点）
    let trend=0;
    for(let i=n-10;i<n-1;i++){
      if(i>=0){
        trend+=smoothed[i+1]-smoothed[i];
      }
    }
    trend=trend/(x[n-1]-x[n-10]);//平均每小时变化
    
    return trend;
  }

  //综合预测（使用两种算法，取平均值，时间默认24小时）
  async predict(deviceId,hours,threshold){
    try{
      const history=await this.getValidHistoryData(deviceId,72);
      
      if(history.length<10){
        return {
          success:false,
          error:'至少需要10个数据点',
          dataNumber:history.length
        };
      }

      //线性回归预测
      const firstResult=this.firstPredict(history);

      //指数平滑预测
      const secondResult=this.secondPredict(history,0.3);//平滑指数默认0.3（无明显趋势倾向，但要防止有大幅度波动情况）

      //综合两种算法的结果（线性回归的斜率+指数平滑的趋势，取平均）
      const rate=(firstResult+secondResult)/2;
      
      //预测未来每个小时的湿度值
      const lastMoisture=history[history.length-1].moisture;
      let prediction=lastMoisture;
      let belowTime=null;
      let below=false;
      for(let t=1;t<=hours;t++){
        prediction=lastMoisture+rate*t;
        if(belowTime===null&&prediction<=threshold){
            belowTime=t;
            break;
        }
      }
      
      //检查预测时间内是否会低于阈值
      if(belowTime!==null){
        below=true;
      }
      
      //返回结果
      return {
        success:true,
        below:below,
        belowTime:belowTime,
        prediction:prediction
      };
    }catch(error){
      console.error('预测失败:',error);
      return { 
        success:false,
        error:error.message 
      };
    }
  }

  //检查是否需要发送预测预警
  async predictionAlert(deviceId,threshold){
    try{
      //获取预测结果
      const predictResult=await this.predict(deviceId,24,threshold);
      
      if(!predictResult.success) return {success:false};

      //检查最近6小时内是否发过预警
      const recentAlert=await this.db.getOne(
        `SELECT id FROM alerts 
         WHERE device_id=? 
           AND type='predicted_dry'
           AND created_time>DATE_SUB(NOW(),INTERVAL 6 HOUR)`,
        [deviceId]
      );

      //如果预测会低于阈值，且6小时内没发过预警则发布，有则返回相关信息，否则返回失败
      if(predictResult.below&&!recentAlert){
        const message=`预测预警：约${predictResult.belowTime}小时后土壤湿度将降至${predictResult.prediction}%，低于阈值${threshold}%，建议提前浇水`;
        console.log(`设备${deviceId}预测预警: ${predictResult.prediction}%<${threshold}%`);
        
        //返回所需信息
        return {
            success:true,
            type:'predicted_dry',
            message:message,
            value:predictResult.prediction,
            threshold:threshold
        }
      }else{
        return {success:false};
      }
    }catch(error){
      console.error('预测预警检查失败:',error);
      return {success:false};
    }
  }
}

module.exports=Predictor;