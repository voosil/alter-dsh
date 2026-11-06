/** Design-stage data only. This service never reads files or executes a shell. */
export interface WorkbenchFile {
  path: string;
  name: string;
  kind: 'directory' | 'file';
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}
export interface WorkbenchService {
  listFiles(root: string, path: string): Promise<WorkbenchFile[]>;
  readFile(root: string, path: string): Promise<string>;
  saveFile(root: string, path: string, content: string): Promise<void>;
  messages(sessionId: string): ChatMessage[];
  sendMessage(
    sessionId: string,
    message: string,
    context: string,
  ): Promise<void>;
}

const files: Record<string, string> = {
  'README.md':
    '# 工作记录\n\n这里记录项目的目标、资料与下一步行动。\n\n## 下一步\n\n- 整理已有资料\n- 核对待确认事项\n',
  'notes/计划.md': '# 本周计划\n\n梳理需求，记录判断，并逐步推进。\n',
  'notes/资料.md': '# 资料索引\n\n将阅读过程中有价值的线索整理到这里。\n',
  'src/index.ts':
    'export function greeting(name: string) {\n  return `你好，${name}`;\n}\n',
  'package.json': '{\n  "name": "workspace",\n  "private": true\n}\n',
};

export function createWorkbenchService(): WorkbenchService {
  const contents = new Map<string, string>();
  const conversations = new Map<string, ChatMessage[]>();
  function relative(root: string, path: string) {
    const base = root.replace(/\/+$/, '');
    if (path !== base && !path.startsWith(`${base}/`))
      throw new Error('文件不在当前工作目录内');
    const value = path.slice(base.length).replace(/^\//, '');
    if (value.split('/').some((part) => part === '..' || part === '.'))
      throw new Error('文件路径无效');
    return value;
  }
  return {
    async listFiles(root, path) {
      const prefix = relative(root, path);
      const children = new Map<string, WorkbenchFile>();
      for (const name of Object.keys(files)) {
        const local = prefix ? `${prefix}/` : '';
        if (!name.startsWith(local)) continue;
        const rest = name.slice(local.length);
        const first = rest.split('/')[0];
        if (!first) continue;
        children.set(first, {
          path: `${path.replace(/\/$/, '')}/${first}`,
          name: first,
          kind: rest.includes('/') ? 'directory' : 'file',
        });
      }
      return [...children.values()].sort((a, b) =>
        a.kind === b.kind
          ? a.name.localeCompare(b.name)
          : a.kind === 'directory'
            ? -1
            : 1,
      );
    },
    async readFile(root, path) {
      const name = relative(root, path);
      const content = contents.get(path) ?? files[name];
      if (content === undefined) throw new Error('文件不存在，请重新选择');
      return content;
    },
    async saveFile(root, path, content) {
      if (files[relative(root, path)] === undefined)
        throw new Error('文件不存在，请重新选择');
      contents.set(path, content);
    },
    messages: (id) => conversations.get(id) ?? [],
    async sendMessage(id, message, context) {
      const current = conversations.get(id) ?? [];
      conversations.set(id, [
        ...current,
        { id: crypto.randomUUID(), role: 'user', content: message },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 380));
      conversations.set(id, [
        ...(conversations.get(id) ?? []),
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `我们可以围绕「${context || '当前空间'}」继续梳理。\n\n你提到：${message}\n\n先把希望达成的结果和已有依据列出来，再确定下一步要核对的问题。`,
        },
      ]);
    },
  };
}
