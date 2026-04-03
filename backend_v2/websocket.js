const WebSocket=require('ws');

class WebSocketServer{
  constructor(server){
    this.wss=new WebSocket.Server({server});
    this.clients=new Map();
    this.heartbeatTimers=new Map();//存储定时器（目的：方便close时清理）
    this.init();
  }

  init(){
    this.wss.on('connection',(ws,req)=>{
      const clientId='client_'+Date.now()+'_'+Math.random().toString(36).substring(2,6);
      const clientIp=req.socket.remoteAddress;
      this.clients.set(clientId,{
        ws,
        subscriptions:new Set(),//用于记录客户端所对应订阅的设备
        ip:clientIp,
        connectedAt:new Date(),
        lastHeartbeat:Date.now(),//记录最后一次心跳时间
        isAlive:true//是否存活
      });

      console.log(`新客户端连接[${clientId}]从${clientIp}`);

      ws.on('message',(message)=>{
        this.handleMessage(clientId,message);
      });

      // 处理断开连接
      ws.on('close',()=>{
        console.log(`客户端断开连接[${clientId}]`);
        this.cleanupClient(clientId);
      });

      // 处理错误
      ws.on('error',(error)=>{
        console.error(`客户端错误[${clientId}]:`,error.message);
        this.cleanupClient(clientId);
      });

      // 发送欢迎消息
      this.sendTo(clientId,{
        type:'welcome',
        message:'连接成功',
        clientId:clientId,
        timestamp:new Date().toISOString()
      });

      //启动心跳检测
      this.startHeartbeat(clientId);
    });
  }

  //处理客户端消息
  handleMessage(clientId,message){
    try{
      const data=JSON.parse(message.toString());
      const client=this.clients.get(clientId);
      if(!client) return;
      switch(data.type){
        
        //订阅设备
        case 'subscribe':
          if(data.deviceId){
            client.subscriptions.add(data.deviceId);
            console.log(`客户端${clientId}订阅了设备${data.deviceId}`);
            this.sendTo(clientId,{
              type:'subscribe_success',
              deviceId:data.deviceId,
              message:'订阅成功'
            });
          }
          break;
        
        //取消订阅
        case 'unsubscribe':
          if(data.deviceId){
            client.subscriptions.delete(data.deviceId);
            console.log(`客户端${clientId}取消订阅设备${data.deviceId}`);
            this.sendTo(clientId,{
              type:'unsubscribe_success',
              deviceId:data.deviceId,
              message:'取消订阅成功'
            });
          }
          break;

        //心跳响应，用pong回应ping
        case 'ping':
          client.lastHeartbeat=Date.now();
          client.isAlive=true;
          this.sendTo(clientId,{
            type:'pong',
            timestamp:new Date().toISOString()
          });
          break;

        //获取客户端状态
        case 'status':
          this.sendTo(clientId,{
            type:'status',
            subscriptions:Array.from(client.subscriptions),
            connectedAt:client.connectedAt
          });
          break;

        default:
          console.log('未知消息类型:',data.type);
      }
    }catch(error){
      console.error('处理WebSocket消息错误:',error);
    }
  }

  //发送消息给指定客户端
  sendTo(clientId,data){
    const client=this.clients.get(clientId);
    if(client&&client.ws.readyState===WebSocket.OPEN){
      try{
        client.ws.send(JSON.stringify(data));
        return true;
      }catch(error){
        console.error(`发送消息给客户端${clientId}失败:`,error.message);
        return false;
      }
    }
    return false;
  }

  //推送数据给订阅了某设备的所有客户端
  pushToDevice(deviceId,data){
    let number=0;
    this.clients.forEach((client,clientId)=>{
      if(client.subscriptions.has(deviceId)&&client.ws.readyState===WebSocket.OPEN){
        client.ws.send(JSON.stringify({
          type:'sensor_data',
          deviceId:deviceId,
          data:data,
          timestamp:new Date().toISOString()
        }));
        number++;
      }
    });
    if(number>0){
      console.log(`已推送数据给${number}个客户端(设备:${deviceId})`);
    }
    return number;
  }

  //推送告警消息
  pushAlert(deviceId,alert){
    let number=0;
    this.clients.forEach((client,clientId)=>{
      if(client.subscriptions.has(deviceId)&&client.ws.readyState===WebSocket.OPEN){
        client.ws.send(JSON.stringify({
          type:'alert',
          deviceId:deviceId,
          alert:alert,
          timestamp:new Date().toISOString()
        }));
        number++;
      }
    });
    if(number>0){
      console.log(`已推送告警给${number}个客户端(设备:${deviceId})`);
    }
    return number;
  }

  //广播消息给所有客户端
  broadcast(message){
    let number=0;
    this.clients.forEach((client,clientId)=>{
      if(client.ws.readyState===WebSocket.OPEN){
        client.ws.send(JSON.stringify({
          type:'broadcast',
          message:message,
          timestamp:new Date().toISOString()
        }));
        number++;
      }
    });
    console.log(`广播消息给${number}个客户端`);
    return number;
  }

  //启动心跳检测
  startHeartbeat(clientId) {
    //清除已存在的定时器（防止重复）
    const existingTimer=this.heartbeatTimers.get(clientId);
    if(existingTimer){
      clearInterval(existingTimer);
    }

    //心跳检测间隔：30秒
    const interval=setInterval(()=>{
      const client=this.clients.get(clientId);
      
      //客户端已不存在，清理定时器
      if(!client){
        clearInterval(interval);
        this.heartbeatTimers.delete(clientId);
        return;
      }

      //检查连接状态
      if(client.ws.readyState!==WebSocket.OPEN){
        console.log(`客户端${clientId}连接已关闭，停止心跳检测`);
        this.cleanupClient(clientId);
        return;
      }

      const now=Date.now();
      const lastHeartbeat=client.lastHeartbeat||client.connectedAt.getTime();
      const heartbeatTimeout=60000;//60秒超时

      //如果超过60秒没有收到心跳，认为客户端已死亡，终止连接
      if(now-lastHeartbeat>heartbeatTimeout){
        console.log(`客户端${clientId}心跳超时(${Math.floor((now-lastHeartbeat)/1000)}秒无响应)，断开连接`);
        client.ws.terminate();
        this.cleanupClient(clientId);
      }
    },30000);//每30秒检查一次
    this.heartbeatTimers.set(clientId,interval);
  }
  
  //清除心跳定时器
  cleanupClient(clientId){
    const timer=this.heartbeatTimers.get(clientId);
    if(timer){
      clearInterval(timer);
      this.heartbeatTimers.delete(clientId);
    }
  
    //从clients Map中删除
    this.clients.delete(clientId);
}

  //获取在线客户端数量
  getClientCount(){
    return this.clients.size;
  }

  //获取设备订阅者数量
  getSubscriberCount(deviceId){
    let number=0;
    this.clients.forEach((client)=>{
      if(client.subscriptions.has(deviceId)){
        number++;
      }
    });
    return number;
  }
}

module.exports=WebSocketServer;