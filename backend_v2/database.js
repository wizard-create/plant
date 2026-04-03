const mysql=require('mysql2');

class Database{
  constructor(){
    this.pool=mysql.createPool({
      host:process.env.DB_HOST,
      user:process.env.DB_USER,
      password:process.env.DB_PASSWORD,
      database:process.env.DB_NAME,
      waitForConnections:true,
      connectionLimit:10,
      queueLimit:0,
      enableKeepAlive:true,
      keepAliveInitialDelay:0
    });

    this.promisePool = this.pool.promise();//后面使用异步函数，因此将连接池转换成promise风格
  }

  //查询多条记录
  async operate(sql,params=[]){
    try{
      const [rows]=await this.promisePool.execute(sql,params);
      return rows;
    }catch(error){
      console.error('数据库操作错误:',error);
      throw error;
    }
  }

  //查询单条记录（经常使用，故添加该方法）
  async getOne(sql,params=[]){
    const rows=await this.operate(sql, params);
    return rows[0]||null;
  }
  
  //用于返回插入时的自增ID
  async insert(sql,params=[]){
    const [result]=await this.promisePool.execute(sql,params);
    return result.insertId;  
  }

  //事务处理（确保多次操作的一致性，只要有一步错误就失败回滚，撤回所有操作，即都不成功）
  async transaction(callback){
    const connection=await this.promisePool.getConnection();
    await connection.beginTransaction();
    try{
      const result=await callback(connection);
      await connection.commit();
      return result;
    }catch(error){
      await connection.rollback();
      throw error;
    }finally{
      connection.release();
    }
  }
}

module.exports=new Database();