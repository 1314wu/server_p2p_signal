// Copyright (C) <2015> Intel Corporation
//
// SPDX-License-Identifier: Apache-2.0

// Socket.IO server implements TransportServer defined in transport_server.idl.

'use strict';

const fs = require('fs');
const path = require('path');
const url = require('url');

const forwardEventName = 'owt-message';

const rootDir = path.dirname(__dirname);
const httpsOptions = {
  key: fs.readFileSync(path.resolve(rootDir, 'cert/key.pem')).toString(),
  cert: fs.readFileSync(path.resolve(rootDir, 'cert/cert.pem')).toString()
};

exports.create = (config) => {
  const server = {};
  const serverConfig = config;

  let plainServer;
  let secureServer;

  // Key is cid, and value is the socket object.
  const connectionMap = new Map();

  function disconnectClient(cid) {
    if (connectionMap.has(cid)) {
      const connection = connectionMap.get(cid);
      connection.emit('server-disconnect');
      connectionMap.delete(cid);
      connection.cid = null;
      connection.disconnect();
    }
  }

  async function emitChatEvent(targetCid, eventName, message) {
    if (connectionMap.has(targetCid)) {
      connectionMap.get(targetCid).emit(eventName, message);
      return;
    } else {
      const error = new Error('Remote endpoint cannot be reached');
      error.code = '2201';
      throw error;
    }
  }

  function onConnection(socket) {
    // `socket.cid` may be filled later by `authentication` message.
    if (socket.cid) {
      // Disconnect previous connection if this user already signed in.
      const cid = socket.cid;
      disconnectClient(cid);
      connectionMap.set(cid, socket);
    }
    socket.on('authentication', (data, ackCallback) => {
      const result = server.onauthentication(server, data.token);
      if (result.error) {
        ackCallback({error: result.error});
        socket.disconnect();
        return;
      }
      // Disconnect previous connection if this user already signed in.
      const cid = result.cid;
      disconnectClient(cid);
      socket.cid = cid;
      connectionMap.set(cid, socket);
      // `server-authenticated` will be removed.
      socket.emit(
          'server-authenticated',
          {uid: cid});  // Send current client id to client.
      console.log(' user numbers:', connectionMap.size);
      ackCallback({uid: cid});
    });

    socket.on('disconnect', (reason) => {  // 注意：添加 reason 参数
      if (socket.cid) {
        const cid = socket.cid;
        
        // 1. 清理连接映射表
        if (connectionMap.has(cid)) {
          connectionMap.delete(cid); // 修复原代码中的错误：delete connectionMap.delete(...)
        }
    
        // 2. 调用断开回调
        server.ondisconnect(cid);
    
        // 3. 根据原因输出日志或执行特定逻辑
        console.log(`${cid} 断开连接。原因: ${reason} | 当前在线用户: ${connectionMap.size}`);
    
        // 4. 针对不同原因执行特定操作
        switch (reason) {
          case 'io server disconnect':
            console.warn(`[${cid}] 被服务端主动踢出`);
            // 示例：记录审计日志或通知管理员
            break;
          case 'ping timeout':
            console.warn(`[${cid}] 心跳超时，网络可能不稳定`);
            // 示例：尝试自动重连（需客户端逻辑）
            break;
          case 'transport close':
            console.warn(`[${cid}] 网络连接突然中断`);
            // 示例：触发网络恢复检测
            break;
          case 'io client disconnect':
            console.log(`[${cid}] 客户端主动断开`);
            break;
          default:
            console.warn(`[${cid}] 未知断开原因: ${reason}`);
        }
      }
    });

    socket.on(forwardEventName, (data, ackCallback) => {
      if (!socket.cid) {
        console.log('Received a message from unauthenticated client.');
        ackCallback(2120);
        socket.disconnect();
        return;
      }
      data.from = socket.cid;
      const to = data.to;
      delete data.to;
      server.onmessage(to, data).then(
          () => {
            ackCallback();
          },
          (error) => {
            ackCallback(error.code);
          });
    });
  }

  function checkOrigin(origin, callback) {
    if (!origin) {
      // Requests initiated from non-web platforms don't have origin.
      callback(null, true);
    } else {
      callback(null, config.allowedOrigins.includes(origin));
    }
  }

  function startServer(config) {
    const serverOptions = {
      // After upgrading all client to Socket.IO 3.x, EIO3 will not be allowed.
      allowEIO3: true,
      cors: {
        origin: checkOrigin,
        // It looks like Socket.IO needs it for cookies.
        credentials: true
      }
    }
    const app = require('express')();
    plainServer = require('socket.io')().listen(app.listen(config.plainPort),
      serverOptions);
    plainServer.on('connection', onConnection);
    secureServer = require('socket.io')()
      .listen(require('https')
        .createServer(httpsOptions, app)
        .listen(config.securePort), serverOptions);
    secureServer.on('connection', onConnection);
    // Signaling server only allowed to be connected with Socket.io.
    // If a client try to connect it with any other methods, server returns 405.
    app.get('*', function(req, res, next) {
      res.setHeader('strict-transport-security', 'max-age=31536000');
      res.send(405, 'OWT signaling server. Please connect it with Socket.IO.');
      
    });

    console.info(
        'Socket.IO server is listening on port ' + config.plainPort +
        '(plain) and ' + config.securePort + '(secure).');
  }

  server.send = (cid, message) => {
    return emitChatEvent(cid, forwardEventName, message);
  };
  server.start = () => {
    return startServer(serverConfig);
  };
  server.disconnect = disconnectClient;
  server.stop = () => {
    console.log('Shutting down Socket.IO server.');
    plainServer.close();
    secureServer.close();
  };
  return server;
}
