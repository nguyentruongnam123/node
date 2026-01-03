#!/usr/bin/env node --max-old-space-size=2048
const http=require('http'),https=require('https'),net=require('net'),url=require('url'),{EventEmitter}=require('events'),cluster=require('cluster'),os=require('os'),{execSync}=require('child_process'),crypto=require('crypto'),fs=require('fs');

// Minimal package list - only essentials
const ESSENTIAL_PACKAGES=['discord.js'];

// User Database
const USER_DB_FILE='./proxy_users.json';
let PROXY_USERS={};
let USER_METADATA={};
let DB_SAVE_TIMER=null;

function loadUserDB(){
  try{
    if(fs.existsSync(USER_DB_FILE)){
      const data=JSON.parse(fs.readFileSync(USER_DB_FILE,'utf8'));
      PROXY_USERS=data.users||{};
      USER_METADATA=data.metadata||{};
      if(cluster.isMaster)console.log(`📁 Loaded ${Object.keys(PROXY_USERS).length} users`);
    }
  }catch(e){
    console.error('❌ Load DB:',e.message);
  }
}

// Batch save - reduce disk I/O
function saveUserDB(){
  if(DB_SAVE_TIMER)clearTimeout(DB_SAVE_TIMER);
  DB_SAVE_TIMER=setTimeout(()=>{
    try{
      fs.writeFileSync(USER_DB_FILE,JSON.stringify({users:PROXY_USERS,metadata:USER_METADATA}));
    }catch(e){}
  },5000);
}

function generateUsername(){
  return'user_'+crypto.randomBytes(6).toString('hex');
}

function generatePassword(){
  return crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g,'').substring(0,16);
}

function createUser(type,duration,dataLimit=null){
  const username=generateUsername();
  const password=generatePassword();
  const now=Date.now();
  let expiresAt=null;
  if(type==='trial')expiresAt=now+(7*24*60*60*1000);
  else if(type==='time')expiresAt=now+duration;
  PROXY_USERS[username]=password;
  USER_METADATA[username]={createdAt:now,expiresAt:expiresAt,type:type,dataLimit:dataLimit,dataUsed:0,lastActivity:now};
  saveUserDB();
  
  if(cluster.isMaster){
    for(const id in cluster.workers){
      cluster.workers[id].send({cmd:'reload_db'});
    }
  }
  
  return{username,password,expiresAt,dataLimit};
}

function checkUserValid(username){
  if(!USER_METADATA[username])return true;
  const meta=USER_METADATA[username];
  if(meta.expiresAt&&Date.now()>meta.expiresAt){
    delete PROXY_USERS[username];
    delete USER_METADATA[username];
    saveUserDB();
    return false;
  }
  if(meta.dataLimit&&meta.dataUsed>=meta.dataLimit){
    delete PROXY_USERS[username];
    delete USER_METADATA[username];
    saveUserDB();
    return false;
  }
  return true;
}

function trackDataUsage(username,bytes){
  if(USER_METADATA[username]){
    USER_METADATA[username].dataUsed+=bytes;
    USER_METADATA[username].lastActivity=Date.now();
    if(Math.random()<0.005)saveUserDB();
  }
}

function formatExpiry(timestamp){
  if(!timestamp)return'Không giới hạn';
  return new Date(timestamp).toLocaleString('vi-VN');
}

function checkInstall(){
  const missing=[];
  for(const p of ESSENTIAL_PACKAGES){
    try{
      require.resolve(p);
    }catch(e){
      missing.push(p);
    }
  }
  if(missing.length>0){
    console.log(`📦 Installing ${missing.length} packages...\n`);
    try{
      execSync(`npm install --no-save ${missing.join(' ')}`,{stdio:'inherit',timeout:120000});
    }catch(e){
      console.log('⚠️ Install failed, continuing...\n');
    }
  }
}

process.setMaxListeners(15);
EventEmitter.defaultMaxListeners=15;

// Disable GC - let Node.js handle it
if(global.gc)setInterval(()=>global.gc(),30000);

// Reduce system optimization aggressiveness
if(process.platform==='linux'&&cluster.isMaster)try{
  ['sysctl -w net.core.somaxconn=32768 2>/dev/null','sysctl -w net.ipv4.tcp_max_syn_backlog=8192 2>/dev/null','sysctl -w net.ipv4.tcp_fin_timeout=15 2>/dev/null','sysctl -w net.ipv4.tcp_keepalive_time=300 2>/dev/null','sysctl -w net.ipv4.tcp_tw_reuse=1 2>/dev/null','sysctl -w net.core.rmem_max=134217728 2>/dev/null','sysctl -w net.core.wmem_max=134217728 2>/dev/null'].forEach(c=>{try{execSync(c);}catch(e){}});
}catch(e){}

// Reduce workers - match CPU cores
const CPU=os.cpus().length;
const WORKERS=Math.min(CPU,4); // Max 4 workers
const PORT=parseInt(process.env.PORT)||parseInt(process.env.SERVER_PORT)||25565;
const HWM=2*1024*1024; // Reduce to 2MB
const SBUF=2*1024*1024; // Reduce to 2MB

function parseAuth(req){
  let authHeader=req.headers['proxy-authorization'];
  if(!authHeader)authHeader=req.headers['authorization'];
  
  if(!authHeader)return null;
  
  if(authHeader.startsWith('Basic ')){
    const b64=authHeader.slice(6);
    try{
      const decoded=Buffer.from(b64,'base64').toString('utf8');
      const[user,pass]=decoded.split(':');
      if(!user||!pass)return null;
      return{user,pass};
    }catch(e){
      return null;
    }
  }
  return null;
}

function verifyAuth(user,pass){
  if(!user||!pass)return false;
  if(!PROXY_USERS[user])return false;
  if(PROXY_USERS[user]!==pass)return false;
  return checkUserValid(user);
}

function sendAuthRequired(socket,isConnect=false){
  if(isConnect){
    socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Proxy"\r\nConnection: close\r\n\r\n');
    socket.end();
  }else{
    socket.writeHead(407,{'Proxy-Authenticate':'Basic realm="Proxy"','Connection':'close'});
    socket.end();
  }
}

if(cluster.isMaster){
  checkInstall();
  loadUserDB();
  
  console.log('╔════════════════════════════════════════╗');
  console.log('║  🔐 OPTIMIZED PROXY + BOT             ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  💪 ${WORKERS} workers (CPU optimized)         ║`);
  console.log('║  🔒 Authentication enabled            ║');
  console.log('║  ⚡ Low resource usage mode           ║');
  console.log('╚════════════════════════════════════════╝\n');
  
  for(let i=0;i<WORKERS;i++){
    cluster.fork();
  }
  
  cluster.on('exit',w=>{
    setTimeout(()=>cluster.fork(),2000);
  });
  
  // Watch DB with debounce - only if file exists
  let watchTimer=null;
  if(fs.existsSync(USER_DB_FILE)){
    fs.watch(USER_DB_FILE,()=>{
      if(watchTimer)clearTimeout(watchTimer);
      watchTimer=setTimeout(()=>{
        loadUserDB();
        for(const id in cluster.workers){
          cluster.workers[id].send({cmd:'reload_db'});
        }
      },1000);
    });
  }else{
    // Create empty DB file
    saveUserDB();
    setTimeout(()=>{
      fs.watch(USER_DB_FILE,()=>{
        if(watchTimer)clearTimeout(watchTimer);
        watchTimer=setTimeout(()=>{
          loadUserDB();
          for(const id in cluster.workers){
            cluster.workers[id].send({cmd:'reload_db'});
          }
        },1000);
      });
    },1000);
  }
  
  // Discord Bot
  const{Client,GatewayIntentBits,EmbedBuilder}=require('discord.js');
  const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]});
  const TOKEN='MTQ1NjU1MjY2MjI2NjAyMzk0Ng.G3l-B7.j_xE7D8xghRECCn4ug9kwvyyaj_HX5Flx05OHI';
  const ADMIN_ID='1442881580388454621';
  const PRICES={minute:100,hour:1000,day:5000,week:30000,month:100000,year:1000000,gb:2000};
  
  client.once('ready',()=>{
    console.log(`🤖 Bot: ${client.user.tag}\n`);
  });
  
  client.on('messageCreate',async msg=>{
    if(msg.author.bot)return;
    const c=msg.content.trim();
    
    if(c==='!delete all'){
      if(msg.author.id!==ADMIN_ID){
        msg.reply('❌ Không có quyền!');
        return;
      }
      const count=Object.keys(PROXY_USERS).length;
      if(count===0){
        msg.reply('❌ Không có user!');
        return;
      }
      PROXY_USERS={};
      USER_METADATA={};
      saveUserDB();
      for(const id in cluster.workers){
        cluster.workers[id].send({cmd:'reload_db'});
      }
      msg.reply(`✅ Đã xóa ${count} users!`);
    }
    else if(c.startsWith('!delete ')){
      if(msg.author.id!==ADMIN_ID){
        msg.reply('❌ Không có quyền!');
        return;
      }
      const args=c.split(' ').slice(1);
      if(args.length<1){
        msg.reply('❌ Dùng: !delete <số>');
        return;
      }
      const num=parseInt(args[0]);
      if(isNaN(num)||num<=0){
        msg.reply('❌ Số không hợp lệ!');
        return;
      }
      const users=Object.keys(PROXY_USERS);
      if(users.length===0){
        msg.reply('❌ Không có user!');
        return;
      }
      const toDelete=users.slice(0,Math.min(num,users.length));
      toDelete.forEach(u=>{
        delete PROXY_USERS[u];
        delete USER_METADATA[u];
      });
      saveUserDB();
      for(const id in cluster.workers){
        cluster.workers[id].send({cmd:'reload_db'});
      }
      msg.reply(`✅ Xóa ${toDelete.length} users!\nCòn: ${Object.keys(PROXY_USERS).length}`);
    }
    else if(c==='!checkuser'){
      const users=Object.keys(PROXY_USERS);
      if(users.length===0){msg.reply('❌ Không có user!');return;}
      const list=users.slice(0,10).map(u=>{
        const m=USER_METADATA[u];
        const exp=m?.expiresAt?new Date(m.expiresAt).toLocaleString('vi-VN'):'∞';
        return`${u}: ${exp}`;
      }).join('\n');
      msg.reply('**Users (10 đầu):**\n```\n'+list+'\n```\nTổng: '+users.length);
    }
    else if(c==='!help'){
      const isAdmin=msg.author.id===ADMIN_ID;
      const fields=[
        {name:'!trial',value:'Trial 7 ngày'},
        {name:'!buyday <số> <đv>',value:'VD: !buyday 7 ngày'},
        {name:'!buydata <GB>',value:'VD: !buydata 50'},
        {name:'!checkuser',value:'Xem users'}
      ];
      if(isAdmin){
        fields.push({name:'🔴 ADMIN',value:'!delete <số>\n!delete all'});
      }
      const e=new EmbedBuilder().setColor('#0099ff').setTitle('🔐 Proxy Bot').addFields(...fields);
      msg.reply({embeds:[e]});
    }
    else if(c==='!trial'){
      try{
        const u=createUser('trial',null,null);
        const proxyAddr='de22.spaceify.eu:25120';
        const e=new EmbedBuilder().setColor('#00ff00').setTitle('🎁 Trial 7 Ngày').addFields({name:'User',value:`\`${u.username}\``},{name:'Pass',value:`\`${u.password}\``},{name:'Proxy',value:`\`${proxyAddr}\``});
        await msg.author.send({embeds:[e]});
        msg.reply('✅ Đã gửi DM!');
      }catch(err){
        msg.reply('❌ Không gửi được DM!');
      }
    }
    else if(c.startsWith('!buyday ')){
      const args=c.split(' ').slice(1);
      if(args.length<2){msg.reply('❌ Dùng: !buyday <số> <đv>');return;}
      const amt=parseInt(args[0]);
      const unit=args[1].toLowerCase();
      if(isNaN(amt)||amt<=0){msg.reply('❌ Số không hợp lệ!');return;}
      let dur=0,price=0,txt='';
      if(['phút','phut','minute'].includes(unit)){dur=amt*60*1000;price=amt*PRICES.minute;txt=amt+' phút';}
      else if(['giờ','gio','hour'].includes(unit)){dur=amt*60*60*1000;price=amt*PRICES.hour;txt=amt+' giờ';}
      else if(['ngày','ngay','day'].includes(unit)){dur=amt*24*60*60*1000;price=amt*PRICES.day;txt=amt+' ngày';}
      else if(['tuần','tuan','week'].includes(unit)){dur=amt*7*24*60*60*1000;price=amt*PRICES.week;txt=amt+' tuần';}
      else if(['tháng','thang','month'].includes(unit)){dur=amt*30*24*60*60*1000;price=amt*PRICES.month;txt=amt+' tháng';}
      else if(['năm','nam','year'].includes(unit)){dur=amt*365*24*60*60*1000;price=amt*PRICES.year;txt=amt+' năm';}
      else{msg.reply('❌ Đơn vị không hợp lệ!');return;}
      try{
        const u=createUser('time',dur,null);
        const proxyAddr='de22.spaceify.eu:25120';
        const e=new EmbedBuilder().setColor('#00ff00').setTitle('✅ Mua '+txt).setDescription(`${price.toLocaleString()}₫`).addFields({name:'User',value:`\`${u.username}\``},{name:'Pass',value:`\`${u.password}\``},{name:'Proxy',value:`\`${proxyAddr}\``});
        await msg.author.send({embeds:[e]});
        msg.reply(`✅ ${txt} - ${price.toLocaleString()}₫`);
      }catch(err){
        msg.reply('❌ Không gửi được DM!');
      }
    }
    else if(c.startsWith('!buydata ')){
      const args=c.split(' ').slice(1);
      if(args.length<1){msg.reply('❌ Dùng: !buydata <GB>');return;}
      const gb=parseInt(args[0]);
      if(isNaN(gb)||gb<=0||gb>1000){msg.reply('❌ Data 1-1000GB!');return;}
      const limit=gb*1024*1024*1024;
      const price=gb*PRICES.gb;
      try{
        const u=createUser('data',null,limit);
        const proxyAddr='de22.spaceify.eu:25120';
        const e=new EmbedBuilder().setColor('#00ff00').setTitle('✅ '+gb+'GB').setDescription(`${price.toLocaleString()}₫`).addFields({name:'User',value:`\`${u.username}\``},{name:'Pass',value:`\`${u.password}\``},{name:'Proxy',value:`\`${proxyAddr}\``});
        await msg.author.send({embeds:[e]});
        msg.reply(`✅ ${gb}GB - ${price.toLocaleString()}₫`);
      }catch(err){
        msg.reply('❌ Không gửi được DM!');
      }
    }
  });
  
  client.login(TOKEN).catch(e=>{
    console.error('❌ Bot login failed:',e.message);
  });
  
}else{
  // WORKER - Optimized
  loadUserDB();
  
  process.on('message',msg=>{
    if(msg.cmd==='reload_db')loadUserDB();
  });
  
  // Reduced agent pools
  const agents={
    http:new http.Agent({keepAlive:1,keepAliveMsecs:30000,maxSockets:256,maxFreeSockets:32,timeout:60000}),
    https:new https.Agent({keepAlive:1,keepAliveMsecs:30000,maxSockets:256,maxFreeSockets:32,timeout:60000,rejectUnauthorized:0})
  };
  
  const turbo=s=>{
    if(!s||s.destroyed)return;
    try{
      s.setNoDelay(1);
      s.setKeepAlive(1,10000);
      s.setTimeout(60000);
    }catch(e){}
  };
  
  const srv=http.createServer((req,res)=>{
    const auth=parseAuth(req);
    if(!auth||!verifyAuth(auth.user,auth.pass)){
      sendAuthRequired(res,false);
      return;
    }
    
    const u=url.parse(req.url);
    if(!u.hostname){res.writeHead(400);res.end();return;}
    turbo(req.socket);
    
    const isH=u.protocol==='https:',mod=isH?https:http,opts={hostname:u.hostname,port:u.port||(isH?443:80),path:u.path,method:req.method,headers:req.headers,agent:isH?agents.https:agents.http,timeout:60000};
    delete opts.headers['proxy-authorization'];
    delete opts.headers['proxy-connection'];
    
    const pReq=mod.request(opts,pRes=>{
      turbo(pRes.socket);
      res.writeHead(pRes.statusCode,pRes.headers);
      let b=0;
      pRes.on('data',c=>{b+=c.length;});
      pRes.pipe(res);
      pRes.on('end',()=>{trackDataUsage(auth.user,b);});
    });
    
    pReq.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    req.pipe(pReq);
  });
  
  srv.on('connect',(req,cSock,head)=>{
    const auth=parseAuth(req);
    
    if(!auth||!verifyAuth(auth.user,auth.pass)){
      sendAuthRequired(cSock,true);
      return;
    }
    
    const[host,port]=req.url.split(':');
    turbo(cSock);
    
    const sSock=net.connect({host,port:port||443,timeout:60000},()=>{
      cSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head&&head.length>0)sSock.write(head);
      turbo(sSock);
      
      let bIn=0,bOut=0;
      cSock.on('data',c=>{bIn+=c.length;});
      sSock.on('data',c=>{bOut+=c.length;});
      
      sSock.pipe(cSock);
      cSock.pipe(sSock);
      
      const clean=()=>{trackDataUsage(auth.user,bIn+bOut);};
      sSock.once('end',clean);
      sSock.once('error',clean);
    });
    
    sSock.on('error',()=>cSock.end());
    cSock.on('error',()=>sSock.end());
  });
  
  srv.listen(PORT,'0.0.0.0',()=>{
    if(cluster.worker.id===1){
      console.log('⚡ Proxy ready: de22.spaceify.eu:25120\n');
    }
  });
}

process.on('uncaughtException',e=>{});
process.on('unhandledRejection',e=>{});
