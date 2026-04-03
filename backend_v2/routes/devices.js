const express=require('express');
const router=express.Router();
const db=require('../database');

//获取所有设备
router.get('/',async(req,res)=>{
  try{
    //向数据库查询所有设备的所有信息（包括设备基本状态，所有未读的告警数据，最新一次的传感器数据）
    const devices=await db.operate(`
      SELECT d.*, 
             (SELECT COUNT(*) FROM alerts WHERE device_id=d.device_id AND be_read=FALSE) as unread_alerts,
             (SELECT moisture FROM sensor_data WHERE device_id=d.device_id ORDER BY created_time DESC LIMIT 1) as last_moisture
      FROM devices d
      ORDER BY d.created_time DESC
    `);

    //计算在线状态（5分钟内算在线）
    devices.forEach(device=>{
      const lastTime=new Date(device.last_time);
      const minutes =(new Date()-lastTime)/(1000*60);//毫秒化为分钟
      device.be_online=minutes<5;
    });

    //响应所有设备所有信息
    res.json(devices);
  }catch(error){
    console.error('获取设备列表失败:',error);
    res.status(500).json({error:error.message});
  }
});

//获取单个设备详情
router.get('/:deviceId',async(req,res)=>{
  try{
    const device=await db.getOne(
      'SELECT * FROM devices WHERE device_id=?',
      [req.params.deviceId]
    );

    //检查设备是否存在
    if(!device){
      return res.status(404).json({error:'设备不存在'});
    }

    //获取最新传感器数据
    const latest=await db.getOne(
      'SELECT * FROM sensor_data WHERE device_id=? ORDER BY created_time DESC LIMIT 1',
      [req.params.deviceId]
    );

    //获取最近24小时的历史数据（每小时一个点）
    const history=await db.operate(`
      SELECT 
        DATE_FORMAT(created_time,'%H:00') as time,
        AVG(moisture) as moisture,
        AVG(temperature) as temperature,
        AVG(light) as light
      FROM sensor_data 
      WHERE device_id=? 
        AND created_time>=DATE_SUB(NOW(),INTERVAL 24 HOUR)
      GROUP BY DATE_FORMAT(created_time,'%Y-%m-%d %H')
      ORDER BY created_time ASC`,
      [req.params.deviceId]
    );

    //获取设备配置
    const config=await db.getOne(
      'SELECT * FROM device_config WHERE device_id = ?',
      [req.params.deviceId]
    );

    //计算在线状态
    const lastTime=new Date(device.last_time);
    const minutes=(Date.now()-lastTime)/(1000*60);
    const be_online=minutes<5;

    //响应单个设备信息
    res.json({
      ...device,
      be_online:be_online,
      latest_data:latest||null,
      history:history,
      config:config||null
    });
  }catch(error){
    console.error('获取设备详情失败:',error);
    res.status(500).json({error:error.message});
  }
});

//更新植物名字（put请求，请求体请求体里须有name）
router.put('/:deviceId',async(req,res)=>{
  try {
    const deviceId=req.params.deviceId;
    const name=req.body.name;
    
    //检查设备是否存在
    const device=await db.getOne(
      'SELECT * FROM devices WHERE device_id=?',
      [deviceId]
    );
    if(!device){
      return res.status(404).json({error:'设备不存在'});
    }

    await db.operate(
      'UPDATE devices SET name=? WHERE device_id=?',
      [name,deviceId]
    );

    res.json({success:true,message:'设备信息已更新'});
  }catch(error){
    console.error('更新名字失败:',error);
    res.status(500).json({error:error.message});
  }
});

//删除设备（delete请求）
router.delete('/:deviceId',async(req,res)=>{
  try{
    const deviceId= req.params.deviceId;

    //删除相关数据（用事务处理，确保都删掉，而不会出现删不干净的情况）
    await db.transaction(async (connection)=>{
      await connection.execute('DELETE FROM sensor_data WHERE device_id=?',[deviceId]);
      await connection.execute('DELETE FROM alerts WHERE device_id=?',[deviceId]);
      await connection.execute('DELETE FROM device_config WHERE device_id=?',[deviceId]);
      await connection.execute('DELETE FROM devices WHERE device_id=?',[deviceId]);
    });

    res.json({success:true,message:'设备已删除'});
  }catch(error){
    console.error('删除设备失败:',error);
    res.status(500).json({error:error.message});
  }
});

module.exports=router;