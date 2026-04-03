const express=require('express');
const router=express.Router();
const db=require('../database');

//获取设备配置
router.get('/:deviceId',async(req,res)=>{
  try{
    const deviceId=req.params.deviceId;
    let config=await db.getOne(
      'SELECT * FROM device_config WHERE device_id=?',
      [deviceId]
    );

    //如果配置不存在，创建默认配置（作用：为了防止不慎误删数据库而做的）
    if(!config){
      await db.operate(
        'INSERT INTO device_config (device_id) VALUES (?)',
        [deviceId]
      );

      config=await db.getOne(
        'SELECT * FROM device_config WHERE device_id=?',
        [deviceId]
      );
    }

    //响应配置信息
    res.json(config);

  }catch(error){
    console.error('获取设备配置失败:',error);
    res.status(500).json({error:error.message});
  }
});

/*
更新设备配置，请求体里可包括json数据moisture_min,moisture_max,temperature_min,
temperature_max,light_min,light_max,auto_water,auto_light（可选任几项）
*/
router.post('/:deviceId',async(req,res)=>{
  try{
    const deviceId=req.params.deviceId;
    const{
      moisture_min,
      moisture_max,
      temperature_min,
      temperature_max,
      light_min,
      light_max,
      auto_water,
      auto_light
    }=req.body;

    //构建更新语句
    const sql=[];
    const params=[];

    //检查哪些要更新，并加入更新语句中
    if (moisture_min!==undefined){
      sql.push('moisture_min=?');
      params.push(moisture_min);
    }
    if (moisture_max!==undefined){
      sql.push('moisture_max=?');
      params.push(moisture_max);
    }
    if(temperature_min!==undefined){
      sql.push('temperature_min=?');
      params.push(temperature_min);
    }
    if(temperature_max!==undefined){
      sql.push('temperature_max=?');
      params.push(temperature_max);
    }
    if(light_min!==undefined){
      sql.push('light_min=?');
      params.push(light_min);
    }
    if(light_max!==undefined){
      sql.push('light_max=?');
      params.push(light_max);
    }
    if(auto_water!==undefined){
      sql.push('auto_water=?');
      params.push(auto_water?1:0);
    }
    if(auto_light!==undefined){
      sql.push('auto_light=?');
      params.push(auto_light?1:0);
    }

    sql.push('updated_time=NOW()');
    params.push(deviceId);

    if(sql.length>0){
      await db.operate(
        `UPDATE device_config SET${sql.join(',')}WHERE device_id=?`,
        params
      );
    }

    //获取更新后的配置
    const newConfig=await db.getOne(
      'SELECT * FROM device_config WHERE device_id = ?',
      [deviceId]
    );

    //响应更新后的配置信息
    res.json({
      success:true,
      message:'配置已更新',
      config:newConfig
    });

  }catch(error){
    console.error('更新设备配置失败:',error);
    res.status(500).json({error:error.message});
  }
});

//重置为默认配置
router.post('/:deviceId/reset',async(req,res)=>{
  try{
    const deviceId=req.params.deviceId;
    await db.operate(
      `UPDATE device_config SET 
       moisture_min=30,
       moisture_max=70,
       temperature_min=15,
       temperature_max=30,
       light_min=500,
       light_max=3000,
       auto_water=TRUE,
       auto_light=TRUE,
       updated_time=NOW()
       WHERE device_id=?`,
      [deviceId]
    );

    //响应已成功
    res.json({success:true,message:'配置已重置为默认值'});

  }catch(error){
    console.error('重置配置失败:',error);
    res.status(500).json({error:error.message});
  }
});

module.exports=router;