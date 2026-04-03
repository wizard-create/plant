const mqtt=require('mqtt');
const db=require('./database');
const MoisturePredictor=require('./predictor');

class MQTTSever{
  constructor(wsServer){
    this.wsServer=wsServer;
    this.client=null;
    this.reconnectAttempts=0;
    this.maxReconnectAttempts=10;
    this.predictor=new MoisturePredictor(db);
    this.connect();
  }

  connect(){
    const clientId='backend_'+Date.now()+'_'+Math.random().toString(36).substring(2,6);
    this.client=mqtt.connect(`mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`,{
      username:process.env.MQTT_USER,
      password:process.env.MQTT_PASSWORD,
      clientId:clientId,
      keepalive:60,
      reconnectPeriod:5000,
      connectTimeout:30000,
      clean:true
    });

    this.client.on('connect',()=>{
      console.log('MQTT服务器连接成功');
      this.reconnectAttempts=0;

      //订阅所有主题
      const topics=[
        'plant/+/sensor',//传感器数据
        'plant/+/status',//设备状态
        'plant/+/heartbeat'//心跳
      ];
      topics.forEach(topic=>{
        console.log(`正在订阅主题:${topic}`);
        this.client.subscribe(topic,{qos:1},(err,granted)=>{
          if(err){
            console.error(`订阅主题失败${topic}:`,err);
          }else{
            console.log(`已订阅主题:${topic}`,granted);
          }
        });
      });
    });

    this.client.on('message',(topic,message)=>{
      this.handleMessage(topic,message);
    });

    this.client.on('error',(err)=>{
      console.error('MQTT错误:',err);
    });

    this.client.on('close',()=>{
      console.log('MQTT连接关闭');
      this.reconnect();
    });
  }

  reconnect(){
    if(this.reconnectAttempts<this.maxReconnectAttempts){
      this.reconnectAttempts++;
      console.log(`尝试重连次数(${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
      setTimeout(()=>{
        this.connect();
      },5000);
    }else{
      console.error('MQTT重连失败');
    }
  }

  //由于涉及有异步操作（写入数据库），因此需要调用异步函数
  async handleMessage(topic,message){
    try{
      const parts=topic.split('/');
      const deviceId=parts[1];
      const type=parts[2];
      const data=JSON.parse(message.toString());

      console.log(`收到设备${deviceId}${type}数据:`,data);

      switch(type){
        case 'sensor':
          await this.handleSensorData(deviceId,data);
          break;
        case 'status':
          await this.handleDeviceStatus(deviceId,data);
          break;
        case 'heartbeat':
          await this.handleHeartbeat(deviceId);
          break;
        default:
          console.log('未知消息类型:',type);
      }
    }catch(error){
      console.error('处理MQTT消息出错:',error.message);
    }
  }

  async handleSensorData(deviceId,data){
    //先看看是否有过该设备信息
    const device=await db.getOne(
      'SELECT device_id FROM devices WHERE device_id = ?',
      [deviceId]
    );
  
    //如果设备不存在，自动创建并生成默认配置
    if(!device){
      console.log(`检测到新设备${deviceId}，自动注册中`);
    
      await db.operate(
        `INSERT INTO devices (device_id,name,last_time) 
        VALUES (?, ?, NOW())`,
        [deviceId,`新植物_${deviceId}`]//填入新植物名称（临时生成的名称）
      );
    
      //同时创建默认配置
      await db.operate(
        `INSERT INTO device_config (device_id) VALUES (?)`,
        [deviceId]
      );
      console.log(`设备${deviceId}自动注册成功`);
    }

    //存入数据库
    await db.operate(
      `INSERT INTO sensor_data
       (device_id,moisture,temperature,humidity,light,battery,wifi)
       VALUES (?,?,?,?,?,?,?)`,
      [
        deviceId,
        data.moisture||null,
        data.temperature||null,
        data.humidity||null,
        data.light||null,
        data.battery||null,
        data.wifi||null,
      ]//用参数数组填而不直接用${data.moisture}之类拼接，可以防止sql恶意注入
    );

    //更新设备最后在线时间
    await db.operate(
      'UPDATE devices SET last_time=NOW() WHERE device_id=?',
      [deviceId]
    );

    //检查阈值并触发告警
    await this.checkThresholds(deviceId,data);

    //通过WebSocket推送给前端
    this.wsServer.pushToDevice(deviceId,{
      ...data,
      deviceId:deviceId,
      updatedAt:new Date().toISOString()
    });
  }

  async handleDeviceStatus(deviceId,data){
    //更新设备状态
    await db.operate(
      `UPDATE devices SET
       rgb_led=?,
       mode=?,
       pump=?,
       led_light=?,
       last_time=NOW()
       WHERE device_id=?`,
      [
        data.rgb_led||'green',
        data.mode||'auto',
        data.pump||false,
        data.led_light||false,
        deviceId
      ]
    );

    //推送给前端
    this.wsServer.pushToDevice(deviceId,{
      type:'status_change',
      ...data,
      deviceId:deviceId
    });
  }

  async handleHeartbeat(deviceId){
    //处理心跳，只更新最后在线时间
    await db.operate(
      'UPDATE devices SET last_time=NOW() WHERE device_id=?',
      [deviceId]
    );
  }

  async checkThresholds(deviceId,data){
    //获取设备配置
    const config=await db.getOne(
      'SELECT * FROM device_config WHERE device_id=?',
      [deviceId]
    );
    if(!config) return;
    const alerts=[];

    //检查土壤湿度
    if(data.moisture!==undefined){
      if(data.moisture<config.moisture_min){
        alerts.push({
          type:'low_moisture',
          message:`土壤过干(${data.moisture}%<${config.moisture_min}%)`,
          value:data.moisture,
          threshold:config.moisture_min
        });

        //自动浇水
        if(config.auto_water){
          this.sendCommand(deviceId,{
            action:'pump',
            value:'on',
            duration:5
          });
        }
        
        //进行预测
        const prediction=await this.predictor.predictionAlert(deviceId,config.moisture_min);
        if(prediction.success){
          alerts.push({
            type:prediction.type,
            message:prediction.message,
            value:prediction.value,
            threshold:prediction.threshold
          });
        }
      }else if(data.moisture>config.moisture_max){
        alerts.push({
          type:'high_moisture',
          message:`土壤过湿(${data.moisture}%>${config.moisture_max}%)`,
          value:data.moisture,
          threshold:config.moisture_max
        });
      }
    }

    //检查温度
    if(data.temperature!==undefined){
      if(data.temperature>config.temperature_max){
        alerts.push({
          type:'high_temperature',
          message:`温度过高(${data.temperature}°C>${config.temperature_max}°C)`,
          value:data.temperature,
          threshold:config.temperature_max
        });
      }else if(data.temperature<config.temperature_min){
        alerts.push({
          type:'low_temperature',
          message:`温度过低 (${data.temperature}°C<${config.temperature_min}°C)`,
          value:data.temperature,
          threshold:config.temperature_min
        });
      }
    }

    //检查光照
    if(data.light!==undefined){
      if (data.light<config.light_min){
        alerts.push({
          type:'low_light',
          message:`光照不足(${data.light}lux<${config.light_min}lux)`,
          value:data.light,
          threshold:config.light_min
        });

        //自动补光
        if(config.auto_light){
          this.sendCommand(deviceId,{
            action:'light',
            value:'on'
          });
        }
      }else if(data.light>config.light_max){
        alerts.push({
          type:'high_light',
          message:`光照过强(${data.light}lux>${config.light_max}lux)`,
          value:data.light,
          threshold:config.light_max
        });
      }
    }

    //检查电量
    if(data.battery!==undefined&&data.battery<20){
      alerts.push({
        type:'low_battery',
        message:`电池电量低(${data.battery}%)`,
        value:data.battery,
        threshold:20
      });
    }

    //检查WiFi信号
    if(data.wifi!==undefined&&data.wifi<-70){
      alerts.push({
        type:'wifi_weak',
        message:`WiFi信号弱(${data.wifi}dBm)`,
        value:data.wifi,
        threshold:-70
      });
    }

    //保存告警并推送
    for(const alert of alerts){
      const alertId=await db.insert(
        `INSERT INTO alerts 
        (device_id,type,message,value,threshold)
         VALUES (?,?,?,?,?)`,
        [
          deviceId,
          alert.type,
          alert.message,
          alert.value,
          alert.threshold
        ]
      );

      this.wsServer.pushAlert(deviceId,{
        alertId:alertId,
        type:alert.type,
        message:alert.message,
        value:alert.value,
        threshold:alert.threshold
      });
      console.log(`设备${deviceId}告警:`,alert.message);
    }
  }

  //发送指令给硬件
  sendCommand(deviceId,command){
    if(this.client&&this.client.connected){
      const topic=`${deviceId}/control`;
      const payload=JSON.stringify(command);
      this.client.publish(topic,payload,{qos:1,retain:false},(err)=>{
        if(err){
          console.error(`发送指令失败:`,err);
        }else{
          console.log(`发送指令给${deviceId}:`,command);
        }
      });
      return true;
    }
    return false;
  }

  // 获取连接状态
  isConnected(){
    return this.client&&this.client.connected;
  }
}

module.exports=MQTTSever;