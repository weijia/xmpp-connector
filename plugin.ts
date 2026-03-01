import type { ClawdbotPluginDefinition, ClawdbotPluginApi, ClawdbotConfig } from '../../src/plugins/types.js';
import { client, xml } from '@xmpp/client';
import { jid } from '@xmpp/jid';

// 消息去重缓存
const processedMessages = new Set<string>();
const messageTimeout = 5 * 60 * 1000; // 5分钟过期

// 运行时
let runtime: any;

// 全局XMPP客户端实例
let globalXmppClient: any;

// 配置处理函数
function getConfig(cfg: ClawdbotConfig) {
  const config = cfg.channels?.['xmpp-connector'] || {};
  console.log('[XMPP] getConfig 被调用，返回配置:', { username: config.username, server: config.server, port: config.port });
  return config;
}

function isConfigured(cfg: ClawdbotConfig) {
  const config = getConfig(cfg);
  const configured = Boolean(config.username && config.password && config.server);
  console.log('[XMPP] isConfigured 被调用，结果:', configured, { username: config.username ? '***' : null, password: config.password ? '***' : null, server: config.server });
  return configured;
}

// 消息去重处理
function isMessageProcessed(messageId: string): boolean {
  return processedMessages.has(messageId);
}

function markMessageProcessed(messageId: string) {
  processedMessages.add(messageId);
  // 5分钟后自动移除
  setTimeout(() => processedMessages.delete(messageId), messageTimeout);
}

// 检查是否处于 debug 模式
function isDebugMode(config?: any): boolean {
  return config?.debug || process.env.OPENCLAW_DEBUG === '1';
}

// 处理 XMPP 消息
async function handleXMPPMessage(ctx: any) {
  const { cfg, accountId, from, text, log, xmppConfig, xmppClient } = ctx;
  const debug = isDebugMode(xmppConfig);
  
  if (debug) {
    console.log(`[XMPP] 处理 XMPP 消息: from=${from}, text=${text}`);
  }
  log?.info?.(`[XMPP] 处理 XMPP 消息: from=${from}, text=${text}`);

  // 检查是否配置了 Gateway
  if (!xmppConfig.gatewayToken) {
    if (debug) {
      console.log('[XMPP] 未配置 Gateway token');
    }
    log?.warn?.(`[XMPP] 未配置 Gateway token`);
    // 发送错误消息
    try {
      const to = jid(from);
      xmppClient.send(xml('message', {
        to: to.toString(),
        type: 'chat'
      }, xml('body', {}, '错误: 未配置 Gateway token')));
    } catch (err) {
      if (debug) {
        console.log('[XMPP] 发送错误消息失败:', err);
      }
    }
    return;
  }

  // 构建请求数据
  const requestData = {
    messages: [
      {
        role: 'user' as const,
        content: text,
      },
    ],
    options: {
      agent: {
        id: 'default',
        name: 'OpenClaw',
      },
      channel: {
        id: 'xmpp-connector',
        from: from,
        to: from,
        accountId: accountId || 'default',
      },
      context: {
        sessionId: `xmpp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        systemPrompt: xmppConfig.systemPrompt || '',
        // 强制新会话
        forceNewSession: true,
      },
    },
  };

  if (debug) {
    console.log('[XMPP] 构建请求数据完成');
    log?.debug?.(`[XMPP] 请求数据:`, requestData);
  }

  try {
    // 调用 Gateway API
    if (debug) {
      console.log('[XMPP] 调用 Gateway API');
    }
    const response = await fetch('http://localhost:18789/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${xmppConfig.gatewayToken}`,
      },
      body: JSON.stringify(requestData),
    });

    if (debug) {
      console.log(`[XMPP] Gateway API 响应状态: ${response.status}`);
    }
    log?.info?.(`[XMPP] Gateway API 响应状态: ${response.status}`);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (debug) {
        console.log(`[XMPP] Gateway API 错误: ${response.status} ${response.statusText}`, errorData);
      }
      log?.error?.(`[XMPP] Gateway API 错误: ${response.status} ${response.statusText}`, errorData);
      // 发送错误消息
      try {
        const to = jid(from);
        xmppClient.send(xml('message', {
          to: to.toString(),
          type: 'chat'
        }, xml('body', {}, `错误: Gateway API 响应失败 (${response.status})`)));
      } catch (err) {
        if (debug) {
          console.log('[XMPP] 发送错误消息失败:', err);
        }
      }
      return;
    }

    const data = await response.json();
    if (debug) {
      console.log('[XMPP] Gateway API 响应成功');
      log?.debug?.(`[XMPP] Gateway API 响应数据:`, data);
    }

    // 提取回复内容
    const reply = data.choices?.[0]?.message?.content || '无响应内容';
    if (debug) {
      console.log(`[XMPP] 提取回复内容: ${reply.slice(0, 50)}...`);
    }
    log?.info?.(`[XMPP] 提取回复内容: ${reply.slice(0, 50)}...`);

    // 发送回复
    try {
      const to = jid(from);
      xmppClient.send(xml('message', {
        to: to.toString(),
        type: 'chat'
      }, xml('body', {}, reply)));
      if (debug) {
        console.log('[XMPP] 回复发送成功');
      }
      log?.info?.(`[XMPP] 回复发送成功`);
    } catch (err) {
      if (debug) {
        console.log('[XMPP] 发送回复失败:', err);
      }
      log?.error?.(`[XMPP] 发送回复失败: ${err}`);
    }

  } catch (err: any) {
    if (debug) {
      console.log(`[XMPP] Gateway 调用错误: ${err.message}`);
      console.log(`[XMPP] 错误堆栈: ${err.stack}`);
    }
    log?.error?.(`[XMPP] Gateway 调用错误: ${err.message}`);
    log?.error?.(`[XMPP] 错误详情: ${err.stack}`);
    // 发送错误消息
    try {
      const to = jid(from);
      xmppClient.send(xml('message', {
        to: to.toString(),
        type: 'chat'
      }, xml('body', {}, `抱歉，处理请求时出错: ${err.message}`)));
    } catch (err) {
      if (debug) {
        console.log('[XMPP] 发送错误消息失败:', err);
      }
    }
  }
}

const xmppPlugin = {
  id: 'xmpp-connector',
  name: 'XMPP Channel',
  description: 'XMPP messaging channel with username/password authentication',
  meta: {
    id: 'xmpp-connector',
    label: 'XMPP',
    selectionLabel: 'XMPP',
    detailLabel: 'XMPP Messaging',
    docsPath: '/channels/xmpp',
    blurb: 'XMPP messaging channel with username/password authentication',
    order: 999,
  },
  capabilities: {
    canSendText: true,
    canReceiveText: true,
    canSendMedia: false,
    canReceiveMedia: false,
    canSendFiles: false,
    canReceiveFiles: false,
    canSendVoice: false,
    canReceiveVoice: false,
    canSendVideo: false,
    canReceiveVideo: false,
    canSendLocation: false,
    canReceiveLocation: false,
    canSendContacts: false,
    canReceiveContacts: false,
    canSendReactions: false,
    canReceiveReactions: false,
    canSendTyping: false,
    canReceiveTyping: false,
    canSendReadReceipts: false,
    canReceiveReadReceipts: false,
    canSendDeliveryReceipts: false,
    canReceiveDeliveryReceipts: false,
    canSendStatus: false,
    canReceiveStatus: false,
    canCreateGroups: false,
    canJoinGroups: false,
    canLeaveGroups: false,
    canManageGroups: false,
    canMentionUsers: false,
    canMentionGroups: false,
    canUseCommands: false,
    canUseActions: false,
    canUseThreads: false,
    canUsePolls: false,
    canUseEncryption: false,
    canUseAuthentication: false,
    canUsePairing: false,
    canUseSetup: false,
    canUseSecurity: false,
    canUseDirectory: false,
    canUseResolver: false,
    canUseHeartbeat: false,
    canUseAgentTools: false,
  },
  configSchema: {
    uiHints: {
      username: { label: 'Username (JID)', help: 'Format: user@domain.com' },
      password: { label: 'Password', help: 'XMPP account password', sensitive: true },
      server: { label: 'Server', help: 'XMPP server hostname' },
      port: { label: 'Port', help: 'XMPP server port (default: 5222)', advanced: true },
      gatewayToken: { label: 'Gateway Token', help: 'OpenClaw gateway token', sensitive: true },
      systemPrompt: { label: 'System Prompt', help: 'Custom system prompt for XMPP messages', advanced: true },
      debug: { label: 'Debug Mode', help: 'Enable debug logging', advanced: true },
    },
    validate: (value: any) => {
      const errors: string[] = [];
      const config = value || {};
      if (!config.username) errors.push('Username is required');
      if (!config.password) errors.push('Password is required');
      if (!config.server) errors.push('Server is required');
      if (!config.gatewayToken) errors.push('Gateway Token is required');
      return errors.length ? { ok: false, errors } : { ok: true };
    },
  },
  config: {
    listAccountIds: (cfg: ClawdbotConfig) => {
      return ['default'];
    },
    resolveAccount: (cfg: ClawdbotConfig, accountId?: string) => {
      const config = getConfig(cfg);
      return { accountId: accountId || 'default', config };
    },
    isEnabled: (account: any, cfg: ClawdbotConfig) => {
      return true;
    },
  },
  outbound: {
    sendText: async (ctx: any) => {
      const { to, text, accountId, cfg, log } = ctx;
      const account = xmppPlugin.config.resolveAccount(cfg, accountId);
      const config = account?.config;
      const debug = isDebugMode(config);
      
      if (debug) {
        console.log(`[XMPP][outbound.sendText] 发送消息: to=${to}, text=${text.slice(0, 50)}...`);
        console.log(`[XMPP][outbound.sendText] 账户ID: ${accountId || 'default'}`);
        console.log(`[XMPP][outbound.sendText] 配置: username=${config?.username}, server=${config?.server}, port=${config?.port || 5222}`);
      }
      log?.info?.(`[XMPP][outbound.sendText] 发送消息: to=${to}, text=${text.slice(0, 50)}...`);
      log?.info?.(`[XMPP][outbound.sendText] 账户ID: ${accountId || 'default'}`);
      log?.info?.(`[XMPP][outbound.sendText] 配置: username=${config?.username}, server=${config?.server}, port=${config?.port || 5222}`);

      if (!config?.username || !config?.password || !config?.server) {
        if (debug) {
          console.log('[XMPP][outbound.sendText] 配置不完整', { username: config?.username, password: config?.password ? '***' : null, server: config?.server });
        }
        throw new Error('XMPP not configured');
      }

      if (!to) {
        if (debug) {
          console.log('[XMPP][outbound.sendText] 目标不能为空');
        }
        throw new Error('Target is required. Format: user@domain.com');
      }

      // 使用全局XMPP实例发送消息
      if (globalXmppClient && globalXmppClient.status === 'online') {
        // 直接发送消息
        if (debug) {
          console.log(`[XMPP][outbound.sendText] 直接发送消息 to="${to}", text="${text.slice(0, 50)}"...`);
        }
        log?.info?.(`[XMPP][outbound.sendText] 直接发送消息 to="${to}", text="${text.slice(0, 50)}"...`);
        
        try {
          const recipient = jid(to);
          globalXmppClient.send(xml('message', {
            to: recipient.toString(),
            type: 'chat'
          }, xml('body', {}, text)));
          const messageId = `msg_${Date.now()}`;
          if (debug) {
            console.log(`[XMPP][outbound.sendText] 消息发送成功，messageId=${messageId}`);
          }
          log?.info?.(`[XMPP][outbound.sendText] 消息发送成功`);
          return { channel: 'xmpp-connector', messageId };
        } catch (err: any) {
          if (debug) {
            console.log(`[XMPP][outbound.sendText] 发送失败: ${err.message}`);
            console.log(`[XMPP][outbound.sendText] 错误堆栈: ${err.stack}`);
          }
          log?.error?.(`[XMPP][outbound.sendText] 发送失败: ${err.message}`);
          throw new Error(err.message);
        }
      } else {
        // 连接未就绪，创建临时实例发送消息
        if (debug) {
          console.log(`[XMPP][outbound.sendText] 创建临时XMPP实例发送消息`);
        }
        
        return new Promise((resolve, reject) => {
          const tempClient = client({
            service: `xmpp://${config.server}:${config.port || 5222}`,
            username: config.username,
            password: config.password,
          });

          tempClient.on('online', () => {
            if (debug) {
              console.log(`[XMPP][outbound.sendText] 临时客户端已连接`);
            }
            
            try {
              const recipient = jid(to);
              tempClient.send(xml('message', {
                to: recipient.toString(),
                type: 'chat'
              }, xml('body', {}, text)));
              
              if (debug) {
                console.log(`[XMPP][outbound.sendText] 发送消息 to="${to}", text="${text.slice(0, 50)}"...`);
              }
              log?.info?.(`[XMPP][outbound.sendText] 发送消息 to="${to}", text="${text.slice(0, 50)}"...`);
              
              // 发送后断开连接
              tempClient.stop();
              const messageId = `msg_${Date.now()}`;
              if (debug) {
                console.log(`[XMPP][outbound.sendText] 消息发送成功，messageId=${messageId}`);
              }
              log?.info?.(`[XMPP][outbound.sendText] 消息发送成功`);
              resolve({ channel: 'xmpp-connector', messageId });
            } catch (err: any) {
              if (debug) {
                console.log(`[XMPP][outbound.sendText] 发送失败: ${err.message}`);
              }
              log?.error?.(`[XMPP][outbound.sendText] 发送失败: ${err.message}`);
              tempClient.stop();
              reject(new Error(err.message));
            }
          });

          tempClient.on('error', (err: any) => {
            if (debug) {
              console.log(`[XMPP][outbound.sendText] 临时客户端错误: ${err.message}`);
            }
            log?.error?.(`[XMPP][outbound.sendText] 临时客户端错误: ${err.message}`);
            tempClient.stop();
            reject(new Error(err.message));
          });

          tempClient.start().catch((err: any) => {
            if (debug) {
              console.log(`[XMPP][outbound.sendText] 临时客户端启动失败: ${err.message}`);
            }
            log?.error?.(`[XMPP][outbound.sendText] 临时客户端启动失败: ${err.message}`);
            reject(new Error(err.message));
          });
        });
      }
    },
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const { account, cfg, abortSignal, log } = ctx;
      const config = account.config;
      const debug = isDebugMode(config);
      
      if (debug) {
        console.log('[XMPP] startAccount 方法被调用');
        console.log('[XMPP] ctx 对象:', ctx);
        console.log('[XMPP] account:', account);
        console.log('[XMPP] cfg:', cfg);
      }

      if (!config.username || !config.password || !config.server) {
        if (debug) {
          console.log('[XMPP] 配置不完整', { username: config.username, password: config.password ? '***' : null, server: config.server });
        }
        throw new Error('XMPP username, password, and server are required');
      }

      if (debug) {
        console.log(`[XMPP] [${account.accountId}] 启动 XMPP 客户端...`);
        console.log(`[XMPP] 连接配置: service=xmpp://${config.server}:${config.port || 5222}, username=${config.username}, password=***`);
      }
      log?.info?.(`[${account.accountId}] 启动 XMPP 客户端...`);
      log?.info?.(`[XMPP] 连接配置: service=xmpp://${config.server}:${config.port || 5222}, username=${config.username}`);

      // 创建新的XMPP客户端实例
      const xmppClient = client({
        service: `xmpp://${config.server}:${config.port || 5222}`,
        username: config.username,
        password: config.password,
      });
      
      // 更新全局XMPP实例
      globalXmppClient = xmppClient;

      // 定义事件处理函数
      const onlineHandler = (jid) => {
        if (debug) {
          console.log(`[XMPP] [${account.accountId}] XMPP 客户端已连接，JID: ${jid?.toString()}`);
        }
        log?.info?.(`[${account.accountId}] XMPP 客户端已连接`);
        
        // 发送在线状态
        xmppClient.send(xml('presence'));
        if (debug) {
          console.log(`[XMPP] [${account.accountId}] 已发送在线状态`);
        }
        log?.info?.(`[XMPP] [${account.accountId}] 已发送在线状态`);
        
        if (runtime) {
          runtime.channel.activity.record('xmpp-connector', account.accountId, 'start');
        }
      };

      const errorHandler = (err: any) => {
        if (debug) {
          console.log(`[XMPP] 连接错误: ${err.message}`);
          console.log(`[XMPP] 错误堆栈: ${err.stack}`);
        }
        log?.error?.(`[XMPP] 连接错误: ${err.message}`);
        log?.error?.(`[XMPP] 错误堆栈: ${err.stack}`);
        if (runtime) {
          runtime.channel.activity.record('xmpp-connector', account.accountId, 'error', { error: err.message });
        }
      };

      const messageHandler = (stanza: any) => {
        // 只处理聊天消息
        if (stanza.is('message') && stanza.attrs.type === 'chat') {
          const body = stanza.getChild('body');
          if (body) {
            const text = body.getText();
            const from = stanza.attrs.from;
            
            console.log(`[XMPP] [DEBUG] 收到聊天消息事件, from=${from}, text="${text.slice(0, 50)}"...`);
            if (debug) {
              console.log(`[XMPP] 收到聊天消息, from=${from}, text="${text.slice(0, 50)}"...`);
            }
            const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            log?.info?.(`[XMPP] 收到聊天消息, from=${from}, text="${text.slice(0, 50)}"...`);

            // 消息去重
            console.log(`[XMPP] [DEBUG] 检查消息是否已处理: messageId=${messageId}, processed=${isMessageProcessed(messageId)}`);
            if (isMessageProcessed(messageId)) {
              if (debug) {
                console.log(`[XMPP] 检测到重复消息，跳过处理 messageId=${messageId}`);
              }
              log?.warn?.(`[XMPP] 检测到重复消息，跳过处理 messageId=${messageId}`);
              return;
            }

            // 标记消息为已处理
            markMessageProcessed(messageId);
            console.log(`[XMPP] [DEBUG] 标记消息为已处理: messageId=${messageId}`);
            if (debug) {
              console.log(`[XMPP] 标记消息为已处理: messageId=${messageId}`);
            }

            // 异步处理消息
            handleXMPPMessage({
              cfg,
              accountId: account.accountId,
              from,
              text,
              log,
              xmppConfig: config,
              xmppClient,
            }).catch((error: any) => {
              if (debug) {
                console.log(`[XMPP] 处理消息异常: ${error.message}`);
                console.log(`[XMPP] 错误堆栈: ${error.stack}`);
              }
              log?.error?.(`[XMPP] 处理消息异常: ${error.message}`);
              log?.error?.(`[XMPP] 错误堆栈: ${error.stack}`);
            });
          }
        }
      };

      const disconnectHandler = () => {
        if (debug) {
          console.log(`[XMPP] [${account.accountId}] XMPP 客户端已断开连接`);
        }
        log?.info?.(`[${account.accountId}] XMPP 客户端已断开连接`);
        
        // 不再自动重连，由Gateway管理生命周期
        // Gateway会在适当的时候重新调用startAccount
      };

      // 添加事件监听器
      if (debug) {
        console.log('[XMPP] 添加事件监听器...');
      }
      log?.info?.(`[XMPP] 添加事件监听器...`);

      xmppClient.on('online', onlineHandler);
      xmppClient.on('error', errorHandler);
      xmppClient.on('stanza', messageHandler);
      xmppClient.on('offline', disconnectHandler);

      // 添加更多事件监听器
      xmppClient.on('stanza', (stanza: any) => {
        console.log(`[XMPP] [DEBUG] 收到Stanza: ${stanza.toString()}`);
        if (debug) {
          console.log(`[XMPP] 收到 Stanza: ${stanza.toString()}`);
          log?.debug?.(`[XMPP] 收到 Stanza: ${stanza.toString()}`);
        }
      });

      if (debug) {
        console.log('[XMPP] 连接到 XMPP 服务器...', {
          service: `xmpp://${config.server}:${config.port || 5222}`,
          username: config.username,
        });
      }
      log?.info?.(`[XMPP] 连接到 XMPP 服务器 ${config.server}:${config.port || 5222}`);

      try {
        await xmppClient.start();
        if (debug) {
          console.log('[XMPP] 连接命令已发送');
        }
        log?.info?.(`[XMPP] 连接命令已发送`);
      } catch (err: any) {
        if (debug) {
          console.log('[XMPP] 连接命令错误:', err.message);
          console.log('[XMPP] 错误堆栈:', err.stack);
        }
        log?.error?.(`[XMPP] 连接命令错误: ${err.message}`);
        log?.error?.(`[XMPP] 错误堆栈: ${err.stack}`);
        throw err;
      }

      let stopped = false;
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          if (stopped) return;
          stopped = true;
          if (debug) {
            console.log(`[XMPP] [${account.accountId}] 停止 XMPP 客户端...`);
          }
          log?.info?.(`[${account.accountId}] 停止 XMPP 客户端...`);
          // 停止客户端
          xmppClient.stop().catch((err: any) => {
            if (debug) {
              console.log('[XMPP] 停止客户端错误:', err.message);
            }
            log?.warn?.(`[XMPP] 停止客户端错误: ${err.message}`);
          });
          if (runtime) {
            runtime.channel.activity.record('xmpp-connector', account.accountId, 'stop');
          }
        });
      }

      return {
        stop: async () => {
          if (stopped) return;
          stopped = true;
          if (debug) {
            console.log(`[XMPP] [${account.accountId}] XMPP Channel 已停止`);
          }
          log?.info?.(`[${account.accountId}] XMPP Channel 已停止`);
          // 停止客户端
          await xmppClient.stop().catch((err: any) => {
            if (debug) {
              console.log('[XMPP] 停止客户端错误:', err.message);
            }
            log?.warn?.(`[XMPP] 停止客户端错误: ${err.message}`);
          });
          if (runtime) {
            runtime.channel.activity.record('xmpp-connector', account.accountId, 'stop');
          }
        },
      };
    },
  },
  status: {
    defaultRuntime: { accountId: 'default', running: false, lastStartAt: null, lastStopAt: null, lastError: null },
    probe: async ({ cfg }: any) => {
      const config = getConfig(cfg);
      const debug = isDebugMode(config);
      
      if (debug) {
        console.log('[XMPP] status.probe 被调用');
        console.log(`[XMPP] 配置: username=${config.username}, server=${config.server}, port=${config.port || 5222}`);
      }
      if (!isConfigured(cfg)) {
        if (debug) {
          console.log('[XMPP] 未配置', { username: config.username, password: config.password ? '***' : null, server: config.server });
        }
        return { ok: false, error: 'Not configured' };
      }
      try {
        if (debug) {
          console.log(`[XMPP] 开始连接测试 ${config.server}:${config.port || 5222}`);
          console.log(`[XMPP] 测试配置: username=${config.username}, password=***, server=${config.server}, port=${config.port || 5222}`);
        }
        // 创建临时XMPP客户端进行连接测试
        const testClient = client({
          service: `xmpp://${config.server}:${config.port || 5222}`,
          username: config.username,
          password: config.password,
        });
        
        // 测试连接 XMPP 服务器
        return new Promise((resolve) => {
          let timeoutId: NodeJS.Timeout;

          testClient.on('online', () => {
            clearTimeout(timeoutId);
            if (debug) {
              console.log('[XMPP] 连接测试成功');
            }
            testClient.stop();
            resolve({ ok: true, details: { username: config.username, server: config.server } });
          });

          testClient.on('error', (err: any) => {
            clearTimeout(timeoutId);
            if (debug) {
              console.log(`[XMPP] 连接测试错误: ${err.message}`);
            }
            testClient.stop();
            resolve({ ok: false, error: err.message });        
          });

          testClient.start().catch((err: any) => {
            clearTimeout(timeoutId);
            if (debug) {
              console.log(`[XMPP] 连接测试启动失败: ${err.message}`);
            }
            resolve({ ok: false, error: err.message });
          });

          // 超时处理
          timeoutId = setTimeout(() => {
            if (debug) {
              console.log('[XMPP] 连接测试超时');
            }
            testClient.stop();
            resolve({ ok: false, error: 'Connection timeout' });
          }, 10000);
        });
      } catch (error: any) {
        if (debug) {
          console.log(`[XMPP] 连接测试异常: ${error.message}`);
        }
        return { ok: false, error: error.message };
      }
    },
    buildChannelSummary: ({ snapshot }: any) => ({
      configured: snapshot?.configured ?? false,
      running: snapshot?.running ?? false,
      lastStartAt: snapshot?.lastStartAt ?? null,
      lastStopAt: snapshot?.lastStopAt ?? null,
      lastError: snapshot?.lastError ?? null,
    }),
  },
};

// ============ 插件注册 ============

const plugin = {
  id: 'xmpp-connector',
  name: 'XMPP Channel',
  description: 'XMPP messaging channel with username/password authentication',
  configSchema: xmppPlugin.configSchema,
  register(api: ClawdbotPluginApi) {
    console.log('[XMPP] 插件注册开始');
    runtime = api.runtime;
    console.log('[XMPP] 注册通道插件');
    console.log('[XMPP] 插件配置Schema:', xmppPlugin.configSchema);
    console.log('[XMPP] 插件配置方法:', Object.keys(xmppPlugin.config));
    console.log('[XMPP] 插件Gateway方法:', Object.keys(xmppPlugin.gateway || {}));
    console.log('[XMPP] 插件Outbound方法:', Object.keys(xmppPlugin.outbound || {}));
    console.log('[XMPP] 插件Status方法:', Object.keys(xmppPlugin.status || {}));
    api.registerChannel({ plugin: xmppPlugin });
    console.log('[XMPP] 插件已加载（支持用户名密码登录和消息收发）');
    console.log('[XMPP] 插件ID:', xmppPlugin.id);
    console.log('[XMPP] 插件名称:', xmppPlugin.name);
    console.log('[XMPP] 插件描述:', xmppPlugin.description);
    console.log('[XMPP] 插件能力:', Object.keys(xmppPlugin.capabilities).filter(key => xmppPlugin.capabilities[key]));
    console.log('[XMPP] 插件meta:', xmppPlugin.meta);

    // ===== Gateway Methods =====

    api.registerGatewayMethod('xmpp-connector.status', async ({ respond, cfg }: any) => {
      const config = getConfig(cfg);
      const debug = isDebugMode(config);
      if (debug) {
        console.log('[XMPP] gateway method: xmpp-connector.status');
      }
      const result = await xmppPlugin.status.probe({ cfg });   
      respond(true, result);
    });

    api.registerGatewayMethod('xmpp-connector.probe', async ({ 
respond, cfg }: any) => {
      const config = getConfig(cfg);
      const debug = isDebugMode(config);
      if (debug) {
        console.log('[XMPP] gateway method: xmpp-connector.probe');
      }
      const result = await xmppPlugin.status.probe({ cfg });
      respond(result.ok, result);
    });

    /**
     * 自动发送消息
     * 参数：
     *   - to: 目标用户 JID
     *   - content: 消息内容
     *   - accountId?: 使用的账号 ID（默认 default）    
     */
    api.registerGatewayMethod('xmpp-connector.sendMessage', async ({ respond, cfg, params, log }: any) => {
      const account = xmppPlugin.config.resolveAccount(cfg, params?.accountId);
      const config = account?.config;
      const debug = isDebugMode(config);
      
      if (debug) {
        console.log('[XMPP] gateway method: xmpp-connector.sendMessage');
        console.log('[XMPP] params:', params);
      }
      const { to, content, accountId } = params || {};

      if (!account.config?.username) {
        if (debug) {
          console.log('[XMPP] 未配置');
        }
        respond(false, { error: 'XMPP not configured' });
        return;
      }

      if (!to || !content) {
        if (debug) {
          console.log('[XMPP] 缺少参数');
        }
        respond(false, { error: 'Missing to or content' });
        return;
      }

      try {
        const result = await xmppPlugin.outbound.sendText({
          to,
          text: content,
          accountId,
          cfg,
          log,
        });
        respond(true, result);
      } catch (error: any) {
        if (debug) {
          console.log(`[XMPP] 发送消息失败: ${error.message}`);
        }
        log?.error?.(`[XMPP] 发送消息失败: ${error.message}`);
        respond(false, { error: error.message });
      }
    });
  },
};

export default plugin;