import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  FileText,
  Folder,
  FolderTree,
  Save,
} from 'lucide-react';
import { Button, Dialog, IconButton, Textarea } from '@alter/ui-system';
import type { WorkbenchFile, WorkbenchService } from '@alter/mock-workbench';
import type { WorkbenchController, WorkbenchTab } from './store';
import styles from './Workbench.module.css';

type FileTarget = { root: string; file: WorkbenchFile };
export function FileView({
  service,
  controller,
  scopeKey,
  tab,
  directories,
}: {
  service: WorkbenchService;
  controller: WorkbenchController;
  scopeKey: string;
  tab: WorkbenchTab;
  directories: string[];
}) {
  const [expanded, setExpanded] = useState<string | null>(
    () => directories[0] ?? null,
  );
  const [treeOpen, setTreeOpen] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingFile, setPendingFile] = useState<FileTarget | null>(null);
  const [retryFile, setRetryFile] = useState<FileTarget | null>(null);
  const request = useRef(0);
  const viewRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const treeId = `wb-tree-${tab.id}`;
  const dirty =
    tab.fileDraft !== undefined && tab.fileDraft !== (tab.fileOriginal ?? '');
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  async function openFile(root: string, file: WorkbenchFile) {
    if (root === tab.fileRoot && file.path === tab.filePath) return;
    if (saving || loading) return;
    if (dirty) {
      setPendingFile({ root, file });
      return;
    }
    await loadFile(root, file);
  }
  async function loadFile(root: string, file: WorkbenchFile) {
    const current = ++request.current;
    setLoading(true);
    setError('');
    setSaved(false);
    setRetryFile(null);
    try {
      const content = await service.readFile(root, file.path);
      if (request.current !== current) return;
      controller.update(scopeKey, tab.id, {
        fileRoot: root,
        filePath: file.path,
        fileDraft: content,
        fileOriginal: content,
        title: file.name,
      });
      if ((viewRef.current?.clientWidth ?? 0) < 520) setTreeOpen(false);
      requestAnimationFrame(() => editorRef.current?.focus());
    } catch (cause) {
      if (request.current !== current) return;
      setError(cause instanceof Error ? cause.message : '文件读取失败，请重试');
      setRetryFile({ root, file });
    } finally {
      if (request.current === current) setLoading(false);
    }
  }
  async function save() {
    if (!tab.fileRoot || !tab.filePath || saving || loading) return false;
    setSaving(true);
    setError('');
    const content = tab.fileDraft ?? '';
    try {
      await service.saveFile(tab.fileRoot, tab.filePath, content);
      controller.update(scopeKey, tab.id, { fileOriginal: content });
      setSaved(true);
      return true;
    } catch {
      setError('保存失败，请重试');
      return false;
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className={styles.fileWorkspace} ref={viewRef}>
      <div className={styles.fileToolbar}>
        <div className={styles.fileLocation} title={tab.filePath ?? '工作目录'}>
          <FileText size={15} />
          <span>
            {tab.filePath
              ? tab.filePath.replace(`${tab.fileRoot}/`, '')
              : '文件'}
          </span>
          {dirty ? (
            <span className={styles.fileState}>未保存</span>
          ) : saved ? (
            <span className={styles.fileState} role="status">
              <Check size={12} />
              已保存
            </span>
          ) : null}
        </div>
        <div className={styles.fileActions}>
          {tab.filePath ? (
            <IconButton
              label={saving ? '正在保存…' : '保存'}
              disabled={!dirty || saving || loading}
              icon={<Save size={15} />}
              onClick={() => void save()}
            />
          ) : null}
          <IconButton
            label={treeOpen ? '收起文件目录' : '展开文件目录'}
            aria-expanded={treeOpen}
            aria-controls={treeId}
            icon={<FolderTree size={16} />}
            onClick={() => setTreeOpen(!treeOpen)}
          />
        </div>
      </div>
      {error ? (
        <div className={styles.fileError} role="alert">
          <span>{error}</span>
          {retryFile ? (
            <Button
              size="sm"
              onClick={() => void loadFile(retryFile.root, retryFile.file)}
            >
              重试
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className={styles.files}>
        <div className={styles.filePreview} aria-busy={loading}>
          {loading ? (
            <p className={styles.emptyText} role="status">
              正在读取文件…
            </p>
          ) : tab.filePath ? (
            <Textarea
              ref={editorRef}
              className={styles.fileEditor}
              aria-label="文件内容"
              spellCheck={false}
              value={tab.fileDraft ?? ''}
              onChange={(event) => {
                setSaved(false);
                controller.update(scopeKey, tab.id, {
                  fileDraft: event.target.value,
                });
              }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                  event.preventDefault();
                  if (dirty) void save();
                }
              }}
            />
          ) : (
            <div className={styles.fileEmpty}>
              <FileText size={28} strokeWidth={1.3} />
              <p>
                {directories.length
                  ? '从右侧目录中选择文件'
                  : '当前空间还没有工作目录'}
              </p>
              {!directories.length ? (
                <span>在空间配置中添加后，即可在这里浏览。</span>
              ) : null}
            </div>
          )}
        </div>
        <nav
          id={treeId}
          hidden={!treeOpen}
          className={styles.fileTree}
          aria-label="工作目录文件"
        >
          <div className={styles.treeHeading}>工作目录</div>
          {directories.map((root) => (
            <section
              key={root}
              className={styles.root}
              data-expanded={expanded === root || undefined}
            >
              <Button
                variant="ghost"
                className={styles.rootButton}
                aria-expanded={expanded === root}
                title={root}
                onClick={() => setExpanded(expanded === root ? null : root)}
              >
                <ChevronRight
                  size={13}
                  className={expanded === root ? styles.rotated : undefined}
                />
                <Folder size={15} />
                <span>{root.split('/').filter(Boolean).at(-1) ?? root}</span>
              </Button>
              {expanded === root ? (
                <div className={styles.rootContents}>
                  <FileBranch
                    key={root}
                    root={root}
                    path={root}
                    depth={0}
                    service={service}
                    selected={tab.fileRoot === root ? tab.filePath : undefined}
                    onFile={(file) => void openFile(root, file)}
                  />
                </div>
              ) : null}
            </section>
          ))}
        </nav>
      </div>
      <Dialog
        title="保存修改后再打开文件？"
        open={Boolean(pendingFile)}
        onClose={() => {
          if (!saving) setPendingFile(null);
        }}
        size="small"
        footer={
          <>
            <Button disabled={saving} onClick={() => setPendingFile(null)}>
              继续编辑
            </Button>
            <Button
              disabled={saving}
              onClick={() => {
                if (!pendingFile) return;
                const target = pendingFile;
                setPendingFile(null);
                void loadFile(target.root, target.file);
              }}
            >
              放弃修改并打开
            </Button>
            <Button
              variant="primary"
              disabled={saving}
              onClick={async () => {
                if (!pendingFile) return;
                const target = pendingFile;
                if (await save()) {
                  setPendingFile(null);
                  await loadFile(target.root, target.file);
                }
              }}
            >
              {saving ? '正在保存…' : '保存并打开'}
            </Button>
          </>
        }
      >
        <p>当前文件有未保存的修改。</p>
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
function FileBranch({
  root,
  path,
  depth,
  service,
  selected,
  onFile,
}: {
  root: string;
  path: string;
  depth: number;
  service: WorkbenchService;
  selected?: string;
  onFile: (file: WorkbenchFile) => void;
}) {
  const [entries, setEntries] = useState<WorkbenchFile[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void service
      .listFiles(root, path)
      .then((files) => {
        if (active) {
          setEntries(files);
          setLoading(false);
          setError('');
        }
      })
      .catch(() => {
        if (active) {
          setLoading(false);
          setError('目录读取失败');
        }
      });
    return () => {
      active = false;
    };
  }, [root, path, service, retry]);
  if (loading)
    return (
      <p className={styles.emptyText} role="status">
        正在读取…
      </p>
    );
  if (error)
    return (
      <Button
        onClick={() => {
          setLoading(true);
          setRetry((value) => value + 1);
        }}
      >
        {error}，重试
      </Button>
    );
  if (!entries.length) return <p className={styles.emptyText}>空目录</p>;
  return (
    <>
      {entries.map((file) => (
        <div key={file.path}>
          <Button
            variant="ghost"
            className={styles.fileRow}
            style={{ paddingLeft: 12 + depth * 14 }}
            title={file.name}
            aria-current={selected === file.path ? 'true' : undefined}
            data-file={file.kind === 'file' || undefined}
            data-selected={selected === file.path || undefined}
            aria-expanded={
              file.kind === 'directory' ? expanded.has(file.path) : undefined
            }
            onClick={() => {
              if (file.kind === 'file') onFile(file);
              else
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(file.path)) next.delete(file.path);
                  else next.add(file.path);
                  return next;
                });
            }}
          >
            {file.kind === 'directory' ? (
              <>
                <ChevronRight
                  size={12}
                  className={
                    expanded.has(file.path) ? styles.rotated : undefined
                  }
                />
                <Folder size={14} />
              </>
            ) : (
              <FileText size={14} />
            )}
            <span>{file.name}</span>
          </Button>
          {file.kind === 'directory' && expanded.has(file.path) ? (
            <FileBranch
              root={root}
              path={file.path}
              depth={depth + 1}
              service={service}
              selected={selected}
              onFile={onFile}
            />
          ) : null}
        </div>
      ))}
    </>
  );
}
