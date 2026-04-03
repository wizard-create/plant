require('dotenv').config();//加载项目根目录下的.env 文件，避免将敏感信息直接硬编码在代码里
const express=require('express');
const http=require('http');
const cors=require('cors');

//导入数据库
const db=require('./database');

//导入WebSocket
const WebSocketServer=require('./websocket');

//导入MQTT
const MQTTSever=require('./mqtt');

//导入路由
const devicesRouter=require('./routes/devices');
const alertsRouter=require('./routes/alerts');
const configRouter=require('./routes/config');

const app=express();
const server=http.createServer(app);

//中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended:true}));

//初始化WebSocket（传入http实例）
const wsServer=new WebSocketServer(server);

//初始化MQTT（传入WebSocket实例）
const mqttSever=new MQTTSever(wsServer);

//导入需要mqttSever的路由
const controlRouter=require('./routes/control')(mqttSever);

app.use('/api/devices',devicesRouter);
app.use('/api/control',controlRouter);
app.use('/api/alerts',alertsRouter);
app.use('/api/config',configRouter);

//根路径:系统状态
app.get('/',(req,res)=>{
  res.json({
    name:'智能植物养护助手后端',
    version:'3.0.0',
    status:'running',
    timestamp:new Date().toISOString(),
    services:{
      http:true,
      websocket:true,
      mqtt:mqttSever.isConnected(),
      database:true
    },
    statistics:{
      clients:wsServer.getClientCount()
    },
    endpoints:{
      devices:'/api/devices',
      control:'/api/control',
      alerts:'/api/alerts',
      config:'/api/config'
    }
  });
});

//健康检查
app.get('/health',(req,res)=>{
  res.json({
    status:'healthy',
    time:new Date().toISOString(),
    uptime:process.uptime()
  });
});

//系统状态统计
app.get('/api/stats',async(req,res)=>{
  try{
    const deviceCount=await db.getOne('SELECT COUNT(*) as count FROM devices');
    const alertCount=await db.getOne('SELECT COUNT(*) as count FROM alerts WHERE be_read=FALSE');
    const todayDataCount=await db.getOne(
      'SELECT COUNT(*) as count FROM sensor_data WHERE DATE(created_time)=CURDATE()'
    );

    res.json({
      deviceAmounts:deviceCount.count,
      unreadAlerts:alertCount.count,
      todayDataCount:todayDataCount.count,
      clients:wsServer.getClientCount()
    });
  } catch(error){
    res.status(500).json({error:error.message});
  }
});

//设备在线状态检查定时任务
setInterval(async()=>{
  try{
    //找出5分钟内没上报数据的设备（iot两分钟传一次，宽松点时限）
    const offlineDevices=await db.operate(
      `SELECT device_id FROM devices 
       WHERE last_time<DATE_SUB(NOW(),INTERVAL 5 MINUTE)`
    );

    for(const device of offlineDevices) {
      //检查最近10分钟是否有离线告警
      const recentAlert=await db.getOne(
        `SELECT id FROM alerts 
         WHERE device_id=? AND type='wifi_disconnected' 
         AND created_time>DATE_SUB(NOW(),INTERVAL 10 MINUTE)`,
        [device.device_id]
      );

      //如果没有就记录离线告警
      if(!recentAlert){
        const alertId=await db.insert(
          `INSERT INTO alerts (device_id,type,message) 
           VALUES (?,'wifi_disconnected','设备离线超过5分钟')`,
          [device.device_id]
        );

        //WebSocket推送
        wsServer.pushAlert(device.device_id,{
          alertId:alertId,
          type:'wifi_disconnected',
          message:'设备离线超过5分钟'
        });

        console.log(`设备${device.device_id}离线`);
      }
    }
  }catch(error){
    console.error('检查设备在线状态失败:',error);
  }
},60000); //每分钟执行一次

//404处理
app.use((req,res)=>{
  res.status(404).json({ 
    error:'接口不存在',
    path:req.path,
    method:req.method
  });
});

//错误处理
app.use((err,req,res,next)=>{
  console.error('服务器错误:',err);
  res.status(500).json({ 
    error:'服务器内部错误',
    message:err.message 
  });
});

//启动服务器
const PORT=process.env.PORT||3000;
server.listen(PORT,'0.0.0.0',()=>{
  console.log(`
  智能植物养护助手后端 V3.0
  ===============================
  HTTP服务:   http://0.0.0.0:${PORT}
  WebSocket:  ws://0.0.0.0:${PORT}
  MQTT服务:   localhost:1883
  环境:       ${process.env.NODE_ENV}
  客户端数:   0
  ===============================
  `);
});

//优雅关闭
process.on('SIGTERM',()=>{
  console.log('收到SIGTERM信号，准备关闭...');
  
  //关闭http服务器
  server.close(()=>{
    console.log('HTTP服务器已关闭');
    
    //关闭MQTT连接
    if(mqttSever.client){
      mqttSever.client.end();
    }
    
    //关闭所有WebSocket连接
    wsServer.wss.close();
  
    process.exit(0);
  });
});

process.on('SIGINT',()=>{
  console.log('收到SIGINT信号，准备关闭...');
  process.exit(0);
});