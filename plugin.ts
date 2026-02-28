/**
 * XMPP Channel Plugin for OpenClaw
 *
 * 通过用户名密码登录XMPP服务器，支持消息收发。
 * 完整接入 OpenClaw 消息处理管道。
 */

import * as xmpp from 'simple-xmpp';
import type { ClawdbotPluginApi, PluginRuntime, ClawdbotConfig } from 'clawdbot/plugin-sdk';

// ============ 常量 ============

export const id = 'xmpp-connector';

let runtime: PluginRuntime | null = null;

function getRuntime(): PluginRuntime {
  if (!runtime) throw new Error('XMPP runtime not initialized');
  return runtime;
}

// ============ Session 管理 ============

/** 用户会话状态：记录最后活跃时间和当前 session 标识 */
interface UserSession {
  lastActivity: number;
  sessionId: string;  // 格式: xmpp-connector:<userId> 或 xmpp-connector:<userId>:<timestamp>
}

/** 用户会话缓存 Map<userId, UserSession> */
const userSessions = new Map<string, UserSession>();

/** 消息去重缓存 Map<messageId, timestamp> - 防止同一消息被重复处理 */
const processedMessages = new Map<string, number>();

/** 消息去重缓存过期时间（5分钟） */
const MESSAGE_DEDUP_TTL = 5 * 60 * 1000;

/** 清理过期的消息去重缓存 */
function cleanupProcessedMessages(): void {
  const now = Date.now();
  for (const [msgId, timestamp] of processedMessages.entries()) {
    if (now - timestamp > MESSAGE_DEDUP_TTL) {
      processedMessages.delete(msgId);
    }
  }
}

/** 检查消息是否已处理过（去重） */
function isMessageProcessed(messageId: string): boolean {
  if (!messageId) return false;
  return processedMessages.has(messageId);
}

/** 标记消息为已处理 */
function markMessageProcessed(messageId: string): void {
  if (!messageId) return;
  processedMessages.set(messageId, Date.now());
  // 定期清理（每处理100条消息清理一次）
  if (processedMessages.size >= 100) {
    cleanupProcessedMessages();
  }
}

/** 新会话触发命令 */
const NEW_SESSION_COMMANDS = ['/new', '/reset', '/clear', '新会话', '重新开始', '清空对话'];

/** 检查消息是否是新会话命令 */
function isNewSessionCommand(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return NEW_SESSION_COMMANDS.some(cmd => trimmed === cmd.toLowerCase());
}

/** 获取或创建用户 session key */
function getSessionKey(
  userId: string,
  forceNew: boolean,
  sessionTimeout: number,
  log?: any,
): { sessionKey: string; isNew: boolean } {
  const now = Date.now();
  const existing = userSessions.get(userId);

  // 强制新会话
  if (forceNew) {
    const sessionId = `xmpp-connector:${userId}:${now}`;
    userSessions.set(userId, { lastActivity: now, sessionId });
    log?.info?.(`[XMPP][Session] 用户主动开启新会话: ${userId}`);
    return { sessionKey: sessionId, isNew: true };
  }

  // 检查超时
  if (existing) {
    const elapsed = now - existing.lastActivity;
    if (elapsed > sessionTimeout) {
      const sessionId = `xmpp-connector:${userId}:${now}`;
      userSessions.set(userId, { lastActivity: now, sessionId });
      log?.info?.(`[XMPP][Session] 会话超时(${Math.round(elapsed / 60000)}分钟)，自动开启新会话: ${userId}`);
      return { sessionKey: sessionId, isNew: true };
    }
    // 更新活跃时间
    existing.lastActivity = now;
    return { sessionKey: existing.sessionId, isNew: false };
  }

  // 首次会话
  const sessionId = `xmpp-connector:${userId}`;
  userSessions.set(userId, { lastActivity: now, sessionId });
  log?.info?.(`[XMPP][Session] 新用户首次会话: ${userId}`);
  return { sessionKey: sessionId, isNew: false };
}

// ============ 配置工具 ============

function getConfig(cfg: ClawdbotConfig) {
  return (cfg?.channels as any)?.['xmpp-connector'] || {};
}

function isConfigured(cfg: ClawdbotConfig): boolean {
  const config = getConfig(cfg);
  return Boolean(config.username && config.password && config.server);
}

// ============ Gateway SSE Streaming ============

interface GatewayOptions {
  userContent: string;
  systemPrompts: string[];
  sessionKey: string;
  gatewayAuth?: string;  // token 或 password，都用 Bearer 格式
  log?: any;
}

async function* streamFromGateway(options: GatewayOptions): AsyncGenerator<string, void, unknown> {
  const { userContent, systemPrompts, sessionKey, gatewayAuth, log } = options;
  const rt = getRuntime();
  const gatewayUrl = `http://127.0.0.1:${rt.gateway?.port || 18789}/v1/chat/completions`;

  const messages: any[] = [];
  for (const prompt of systemPrompts) {
    messages.push({ role: 'system', content: prompt });
  }
  messages.push({ role: 'user', content: userContent });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (gatewayAuth) {
    headers['Authorization'] = `Bearer ${gatewayAuth}`;
  }

  log?.info?.(`[XMPP][Gateway] POST ${gatewayUrl}, session=${sessionKey}, messages=${messages.length}`);

  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'default',
      messages,
      stream: true,
      user: sessionKey,  // 用于 session 持久化
    }),
  });

  log?.info?.(`[XMPP][Gateway] 响应 status=${response.status}, ok=${response.ok}, hasBody=${!!response.body}`);

  if (!response.ok || !response.body) {
    const errText = response.body ? await response.text() : '(no body)';
    log?.error?.(`[XMPP][Gateway] 错误响应: ${errText}`);
    throw new Error(`Gateway error: ${response.status} - ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;

      try {
        const chunk = JSON.parse(data);
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {}
    }
  }
}

// ============ 消息处理 ============

/**
 * 处理收到的XMPP消息
 */
async function handleXMPPMessage(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  from: string;
  text: string;
  log?: any;
  xmppConfig: any;
  xmppClient: any;
}): Promise<void> {
  const { cfg, accountId, from, text, log, xmppConfig, xmppClient } = params;

  if (!text) return;

  const senderId = from;
  const senderName = from.split('@')[0];

  log?.info?.(`[XMPP] 收到消息: from=${senderName} text="${text.slice(0, 50)}..."`);

  // ===== Session 管理 =====
  const sessionTimeout = xmppConfig.sessionTimeout ?? 1800000; // 默认 30 分钟
  const forceNewSession = isNewSessionCommand(text);

  // 如果是新会话命令，直接回复确认消息
  if (forceNewSession) {
    const { sessionKey } = getSessionKey(senderId, true, sessionTimeout, log);
    xmppClient.send(from, '✨ 已开启新会话，之前的对话已清空。');
    log?.info?.(`[XMPP] 用户请求新会话: ${senderId}, newKey=${sessionKey}`);
    return;
  }

  // 获取或创建 session
  const { sessionKey, isNew } = getSessionKey(senderId, false, sessionTimeout, log);
  log?.info?.(`[XMPP][Session] key=${sessionKey}, isNew=${isNew}`);

  // Gateway 认证：优先使用 token，其次 password
  const gatewayAuth = xmppConfig.gatewayToken || xmppConfig.gatewayPassword || '';

  // 构建 system prompts
  const systemPrompts: string[] = [];

  // 自定义 system prompt
  if (xmppConfig.systemPrompt) {
    systemPrompts.push(xmppConfig.systemPrompt);
  }

  // 处理消息
  let fullResponse = '';
  try {
    log?.info?.(`[XMPP] 开始请求 Gateway 流式接口...`);
    for await (const chunk of streamFromGateway({
      userContent: text,
      systemPrompts,
      sessionKey,
      gatewayAuth,
      log,
    })) {
      fullResponse += chunk;
    }

    log?.info?.(`[XMPP] Gateway 流完成，共 ${fullResponse.length} 字符`);

    // 发送响应
    if (fullResponse) {
      xmppClient.send(from, fullResponse);
      log?.info?.(`[XMPP] 消息回复完成，共 ${fullResponse.length} 字符`);
    } else {
      xmppClient.send(from, '（无响应）');
      log?.info?.(`[XMPP] 无响应内容`);
    }

  } catch (err: any) {
    log?.error?.(`[XMPP] Gateway 调用失败: ${err.message}`);
    log?.error?.(`[XMPP] 错误详情: ${err.stack}`);
    xmppClient.send(from, `抱歉，处理请求时出错: ${err.message}`);
  }
}

// ============ 插件定义 ============

const meta = {
  id: 'xmpp-connector',
  label: 'XMPP',
  selectionLabel: 'XMPP',
  docsPath: '/channels/xmpp-connector',
  docsLabel: 'xmpp-connector',
  blurb: 'XMPP 消息通道，支持用户名密码登录和消息收发。',
  order: 80,
  aliases: ['xmpp'],
};

const xmppPlugin = {
  id: 'xmpp-connector',
  meta,
  capabilities: {
    chatTypes: ['direct'],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ['channels.xmpp-connector'] },
  configSchema: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: true },
        username: { type: 'string', description: 'XMPP 用户名' },
        password: { type: 'string', description: 'XMPP 密码' },
        server: { type: 'string', description: 'XMPP 服务器地址' },
        port: { type: 'number', default: 5222, description: 'XMPP 服务器端口' },
        systemPrompt: { type: 'string', default: '', description: '自定义系统提示' },
        gatewayToken: { type: 'string', default: '', description: 'Gateway auth token (Bearer)' },
        gatewayPassword: { type: 'string', default: '', description: 'Gateway auth password (alternative to token)' },
        sessionTimeout: { type: 'number', default: 1800000, description: 'Session timeout in ms (default 30min)' },
        debug: { type: 'boolean', default: false },
      },
      required: ['username', 'password', 'server'],
    },
    uiHints: {
      enabled: { label: 'Enable XMPP' },
      username: { label: 'Username' },
      password: { label: 'Password', sensitive: true },
      server: { label: 'Server' },
      port: { label: 'Port' },
    },
  },
  config: {
    listAccountIds: (cfg: ClawdbotConfig) => {
      const config = getConfig(cfg);
      return config.accounts
        ? Object.keys(config.accounts)
        : (isConfigured(cfg) ? ['default'] : []);
    },
    resolveAccount: (cfg: ClawdbotConfig, accountId?: string) => {
      const config = getConfig(cfg);
      const id = accountId || 'default';
      if (config.accounts?.[id]) {
        return { accountId: id, config: config.accounts[id], enabled: config.accounts[id].enabled !== false };
      }
      return { accountId: 'default', config, enabled: config.enabled !== false };
    },
    defaultAccountId: () => 'default',
    isConfigured: (account: any) => Boolean(account.config?.username && account.config?.password && account.config?.server),
    describeAccount: (account: any) => ({
      accountId: account.accountId,
      name: account.config?.name || 'XMPP',
      enabled: account.enabled,
      configured: Boolean(account.config?.username),
    }),
  },
  security: {
    resolveDmPolicy: ({ account }: any) => ({
      policy: account.config?.dmPolicy || 'open',
      allowFrom: account.config?.allowFrom || [],
      policyPath: 'channels.xmpp-connector.dmPolicy',
      allowFromPath: 'channels.xmpp-connector.allowFrom',
      approveHint: '使用 /allow xmpp-connector:<userId> 批准用户',
      normalizeEntry: (raw: string) => raw.replace(/^(xmpp-connector|xmpp):/i, ''),
    }),
  },
  messaging: {
    // 注意：normalizeTarget 接收字符串，返回字符串
    normalizeTarget: (raw: string) => {
      if (!raw) return undefined;
      // 去掉渠道前缀，但保持原始大小写
      return raw.trim().replace(/^(xmpp-connector|xmpp):/i, '');
    },
    targetResolver: {
      // 支持 XMPP JID 格式
      looksLikeId: (id: string) => /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(id),
      hint: 'user@domain.com',
    },
  },
  outbound: {
    deliveryMode: 'direct' as const,
    textChunkLimit: 4000,
    /**
     * 主动发送文本消息
     * @param ctx.to 目标格式：user@domain.com
     * @param ctx.text 消息内容
     * @param ctx.accountId 账号 ID
     */
    sendText: async (ctx: any) => {
      const { cfg, to, text, accountId, log } = ctx;
      const account = xmppPlugin.config.resolveAccount(cfg, accountId);
      const config = account?.config;

      if (!config?.username || !config?.password || !config?.server) {
        throw new Error('XMPP not configured');
      }

      if (!to) {
        throw new Error('Target is required. Format: user@domain.com');
      }

      // 创建临时 XMPP 客户端发送消息
      return new Promise((resolve, reject) => {
        const client = xmpp.createClient({
          jid: config.username,
          password: config.password,
          host: config.server,
          port: config.port || 5222,
        });

        client.on('online', () => {
          log?.info?.(`[XMPP][outbound.sendText] 发送消息: to="${to}", text="${text.slice(0, 50)}..."`);
          client.send(to, text);
          // 发送后立即断开连接
          client.end();
          resolve({ channel: 'xmpp-connector', messageId: `msg_${Date.now()}` });
        });

        client.on('error', (err: any) => {
          log?.error?.(`[XMPP][outbound.sendText] 发送失败: ${err.message}`);
          client.end();
          reject(new Error(err.message));
        });

        client.connect();
      });
    },
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const { account, cfg, abortSignal } = ctx;
      const config = account.config;

      if (!config.username || !config.password || !config.server) {
        throw new Error('XMPP username, password, and server are required');
      }

      ctx.log?.info(`[${account.accountId}] 启动 XMPP 客户端...`);

      const client = xmpp.createClient({
        jid: config.username,
        password: config.password,
        host: config.server,
        port: config.port || 5222,
      });

      client.on('online', () => {
        ctx.log?.info(`[${account.accountId}] XMPP 客户端已连接`);
        const rt = getRuntime();
        rt.channel.activity.record('xmpp-connector', account.accountId, 'start');
      });

      client.on('error', (err: any) => {
        ctx.log?.error?.(`[XMPP] 连接错误: ${err.message}`);
        const rt = getRuntime();
        rt.channel.activity.record('xmpp-connector', account.accountId, 'error', { error: err.message });
      });

      client.on('chat', async (from: string, text: string) => {
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        ctx.log?.info?.(`[XMPP] 收到聊天消息, from=${from}, text="${text.slice(0, 50)}..."`);

        // 消息去重
        if (isMessageProcessed(messageId)) {
          ctx.log?.warn?.(`[XMPP] 检测到重复消息，跳过处理: messageId=${messageId}`);
          return;
        }

        // 标记消息为已处理
        markMessageProcessed(messageId);

        // 异步处理消息
        try {
          await handleXMPPMessage({
            cfg,
            accountId: account.accountId,
            from,
            text,
            log: ctx.log,
            xmppConfig: config,
            xmppClient: client,
          });
        } catch (error: any) {
          ctx.log?.error?.(`[XMPP] 处理消息异常: ${error.message}`);
        }
      });

      client.connect();

      let stopped = false;
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          if (stopped) return;
          stopped = true;
          ctx.log?.info(`[${account.accountId}] 停止 XMPP 客户端...`);
          client.end();
          const rt = getRuntime();
          rt.channel.activity.record('xmpp-connector', account.accountId, 'stop');
        });
      }

      return {
        stop: () => {
          if (stopped) return;
          stopped = true;
          ctx.log?.info(`[${account.accountId}] XMPP Channel 已停止`);
          client.end();
          const rt = getRuntime();
          rt.channel.activity.record('xmpp-connector', account.accountId, 'stop');
        },
      };
    },
  },
  status: {
    defaultRuntime: { accountId: 'default', running: false, lastStartAt: null, lastStopAt: null, lastError: null },
    probe: async ({ cfg }: any) => {
      if (!isConfigured(cfg)) return { ok: false, error: 'Not configured' };
      try {
        const config = getConfig(cfg);
        // 尝试连接 XMPP 服务器
        return new Promise((resolve) => {
          const client = xmpp.createClient({
            jid: config.username,
            password: config.password,
            host: config.server,
            port: config.port || 5222,
          });

          client.on('online', () => {
            client.end();
            resolve({ ok: true, details: { username: config.username, server: config.server } });
          });

          client.on('error', (err: any) => {
            client.end();
            resolve({ ok: false, error: err.message });
          });

          client.connect();

          // 超时处理
          setTimeout(() => {
            client.end();
            resolve({ ok: false, error: 'Connection timeout' });
          }, 10000);
        });
      } catch (error: any) {
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
  configSchema: {
    type: 'object',
    additionalProperties: true,
    properties: { enabled: { type: 'boolean', default: true } },
  },
  register(api: ClawdbotPluginApi) {
    runtime = api.runtime;
    api.registerChannel({ plugin: xmppPlugin });

    // ===== Gateway Methods =====

    api.registerGatewayMethod('xmpp-connector.status', async ({ respond, cfg }: any) => {
      const result = await xmppPlugin.status.probe({ cfg });
      respond(true, result);
    });

    api.registerGatewayMethod('xmpp-connector.probe', async ({ respond, cfg }: any) => {
      const result = await xmppPlugin.status.probe({ cfg });
      respond(result.ok, result);
    });

    /**
     * 主动发送消息
     * 参数：
     *   - to: 目标用户 JID
     *   - content: 消息内容
     *   - accountId?: 使用的账号 ID（默认 default）
     */
    api.registerGatewayMethod('xmpp-connector.sendMessage', async ({ respond, cfg, params, log }: any) => {
      const { to, content, accountId } = params || {};
      const account = xmppPlugin.config.resolveAccount(cfg, accountId);

      if (!account.config?.username) {
        return respond(false, { error: 'XMPP not configured' });
      }

      if (!to) {
        return respond(false, { error: 'to is required' });
      }

      if (!content) {
        return respond(false, { error: 'content is required' });
      }

      try {
        const result = await xmppPlugin.outbound.sendText({
          cfg,
          to,
          text: content,
          accountId,
          log,
        });
        respond(true, result);
      } catch (error: any) {
        respond(false, { error: error.message });
      }
    });
  },
};

export default plugin;