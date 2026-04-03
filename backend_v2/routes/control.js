const express=require('express');
const router=express.Router();
const db=require('../database');

module.exports=(mqttSever)=>{
  //控制水泵，请求体里须有deviceId,action(:on/off),duration（可选，不填默认5秒）
  router.post('/pump',async(req,res)=>{
    try{
      const {deviceId,action,duration}=req.body;

      //验证参数，处理错误
      if(!deviceId||!['on','off'].includes(action)){
        return res.status(400).json({error:'参数错误'});
      }

      //检查设备是否存在
      const device=await db.getOne(
        'SELECT device_id FROM devices WHERE device_id=?',
        [deviceId]
      );
      if(!device){
        return res.status(404).json({error:'设备不存在'});
      }

      //构建指令
      const command={
        action:'pump',
        value:action,
        duration:action==='on'?(duration||5):0
      };

      //通过MQTT发送
      const sent=mqttSever.sendCommand(deviceId,command);

      if(sent){
        //记录控制日志
        console.log(`设备${deviceId}水泵${action==='on'?'开启':'关闭'}`);

        //更新设备状态
        await db.operate(
          'UPDATE devices SET pump=? WHERE device_id=?',
          [action==='on'?1:0,deviceId]
        );

        //响应成功消息
        res.json({
          success:true,
          message:`水泵${action==='on'?'开启':'关闭'}指令已发送`,
          command:command
        });
      }else{
        res.status(500).json({error:'MQTT服务器连接失败'});
      }
    }catch(error){
      console.error('控制水泵失败:',error);
      res.status(500).json({error:error.message});
    }
  });

  //控制补光灯，请求体里须有deviceId,action(:on/off)
  router.post('/light',async(req,res)=>{
    try{
      const {deviceId,action}=req.body;

      if(!deviceId||!['on','off'].includes(action)){
        return res.status(400).json({error:'参数错误'});
      }

      const command={
        action:'light',
        value:action
      };

      const sent=mqttSever.sendCommand(deviceId,command);

      if(sent){
        await db.operate(
          'UPDATE devices SET led_light=? WHERE device_id=?',
          [action==='on'?1:0,deviceId]
        );

        res.json({
          success:true,
          message:`补光灯${action==='on'?'开启':'关闭'}`
        });
      }else{
        res.status(500).json({error:'MQTT服务器连接失败'});
      }
    }catch(error){
      console.error('控制补光灯失败:',error);
      res.status(500).json({error:error.message});
    }
  });

  //控制LED，请求体里须有deviceId,color(:red/green/blue/yellow/purple/off)
  router.post('/led',async(req,res)=>{
    try{
      const {deviceId,color}=req.body;

      //验证颜色是否有误
      const supportedColors=['red','green','blue','yellow','purple','off'];
      if(!deviceId||!supportedColors.includes(color)){
        return res.status(400).json({error:'参数错误'});
      }

      const command={
        action:'led',
        value:color
      };

      const sent=mqttSever.sendCommand(deviceId,command);

      if(sent){
        await db.operate(
          'UPDATE devices SET led_color=? WHERE device_id=?',
          [color,deviceId]
        );

        res.json({
          success:true,
          message:`LED已设为${color}色`
        });
      }else{
        res.status(500).json({error:'MQTT服务器连接失败'});
      }
    }catch(error){
      console.error('控制LED失败:',error);
      res.status(500).json({error:error.message});
    }
  });

  //切换模式，请求体里须有deviceId,mode(:auto/manual)
  router.post('/mode',async(req,res)=>{
    try{
      const {deviceId,mode}=req.body;

      if(!deviceId||!['auto','manual'].includes(mode)){
        return res.status(400).json({error:'参数错误'});
      }

      const command={
        action:'mode',
        value:mode
      };

      const sent=mqttSever.sendCommand(deviceId,command);

      if(sent){
        await db.operate(
          'UPDATE devices SET mode=? WHERE device_id=?',
          [mode,deviceId]
        );

        res.json({
          success:true,
          message:`已切换到${mode==='auto'?'自动':'手动'}模式`
        });
      }else{
        res.status(500).json({error:'MQTT服务器连接失败'});
      }

    }catch(error){
      console.error('切换模式失败:',error);
      res.status(500).json({error:error.message});
    }
  });

  return router;
};