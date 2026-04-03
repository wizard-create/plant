const express=require('express');
const router=express.Router();
const db=require('../database');

//获取设备的告警记录（可选：URL后的查询参数limit（限制记录条数，默认60）和unread(是否获取未读消息，默认true)）
router.get('/:deviceId',async(req,res)=>{
  try{
    const deviceId=req.params.deviceId;
    const limit=parseInt(req.query.limit)||60;
    const unread=req.query.unread==='true';
    let sql='SELECT * FROM alerts WHERE device_id=?';

    //选择为已读或未读类型
    if(unread){
      sql+=' AND be_read=FALSE';
    }else{
      sql+=' AND be_read=TRUE'
    }
    sql+=' ORDER BY created_time DESC LIMIT ?';
    const alerts=await db.operate(sql,
      [deviceId,limit]
    );
    
    //响应该设备告警记录
    res.json(alerts);
  }catch(error){
    console.error('获取告警记录失败:',error);
    res.status(500).json({error:error.message});
  }
});

//获取未读告警数量
router.get('/:deviceId/unreadCount',async(req,res)=>{
  try{
    const deviceId=req.params.deviceId;
    const result=await db.getOne(
      'SELECT COUNT(*) as count FROM alerts WHERE device_id=? AND be_read=FALSE',
      [deviceId]
    );

    //响应未读告警数量
    res.json({count:result.count});
  }catch(error){
    console.error('获取未读告警数失败:',error);
    res.status(500).json({error:error.message});
  }
});

//标记告警为已读（其中alertId来自于websocket推送的告警消息）
router.post('/:alertId/readOne',async(req,res)=>{
  try{
    const alertId=req.params.alertId;
    await db.operate(
      'UPDATE alerts SET be_read=TRUE WHERE id=?',
      [alertId]
    );
    
    //响应已成功
    res.json({success:true});

  }catch(error){
    console.error('标记告警失败:',error);
    res.status(500).json({error:error.message});
  }
});

//标记所有告警为已读
router.post('/:deviceId/readAll',async(req,res)=>{
  try{
    const deviceId=req.params.deviceId;
    await db.operate(
      'UPDATE alerts SET be_read=TRUE WHERE device_id=?',
      [deviceId]
    );

    //响应已成功
    res.json({success:true,message:'所有告警已标记为已读'});
  
  }catch(error){
    console.error('标记所有告警失败:',error);
    res.status(500).json({error:error.message});
  }
});

//删除告警
router.delete('/:alertId',async(req,res)=>{
  try{
    const alertId=req.params.alertId;
    await db.operate('DELETE FROM alerts WHERE id=?',[alertId]);

    //响应已成功
    res.json({success:true});

  }catch(error){
    console.error('删除告警失败:',error);
    res.status(500).json({error:error.message});
  }
});

module.exports=router;