import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Bold, FilePlus2, Italic, List, Mic } from 'lucide-react';
import { Button, IconButton } from '@alter/ui-system';
import { placeCaretAtEnd } from './editor/editor-utils';
import styles from './ThoughtComposer.module.css';

interface SpeechResultAlternative {
  transcript: string;
}

interface SpeechResult {
  isFinal: boolean;
  0: SpeechResultAlternative;
}

interface SpeechResultList {
  length: number;
  [index: number]: SpeechResult;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechResultList;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

type SpeechConstructor = new () => SpeechRecognitionLike;

export function ThoughtComposer({
  initialContent = '',
  placeholder = '记下一个想法…',
  submitLabel = '记下',
  autoFocus = false,
  compact = false,
  onSubmit,
  onCancel,
  onConvertToDocument,
}: {
  initialContent?: string;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  compact?: boolean;
  onSubmit: (html: string) => Promise<void> | void;
  onCancel?: () => void;
  onConvertToDocument?: (html: string) => Promise<void> | void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const startVoiceRef = useRef<() => void>(() => {});
  const stopVoiceRef = useRef<() => void>(() => {});
  const [empty, setEmpty] = useState(!initialContent);
  const [listening, setListening] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (editorRef.current) editorRef.current.innerHTML = initialContent;
    if (autoFocus) window.setTimeout(() => editorRef.current?.focus(), 40);
  }, [initialContent, autoFocus]);

  useEffect(() => {
    return () => recognitionRef.current?.stop();
  }, []);

  useEffect(() => {
    startVoiceRef.current = startVoice;
    stopVoiceRef.current = stopVoice;
  });

  useEffect(() => {
    let holdTimer: number | undefined;
    let holding = false;
    function isFn(event: globalThis.KeyboardEvent) {
      return event.key === 'Fn' || event.code === 'Fn';
    }
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (!isFn(event) || event.repeat) return;
      if (!editorRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      window.clearTimeout(holdTimer);
      holdTimer = window.setTimeout(() => {
        holding = true;
        startVoiceRef.current();
      }, 450);
    }
    function handleKeyUp(event: globalThis.KeyboardEvent) {
      if (!isFn(event)) return;
      window.clearTimeout(holdTimer);
      if (!holding) return;
      holding = false;
      stopVoiceRef.current();
    }
    function handleBlur() {
      window.clearTimeout(holdTimer);
      if (!holding) return;
      holding = false;
      stopVoiceRef.current();
    }
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  function value() {
    return editorRef.current?.innerHTML ?? '';
  }

  function hasContent() {
    return (editorRef.current?.textContent ?? '').trim().length > 0;
  }

  function syncEmpty() {
    setEmpty(!hasContent());
  }

  async function submit() {
    if (!hasContent()) {
      setError('写点什么再记下');
      editorRef.current?.focus();
      return;
    }
    setSending(true);
    setError('');
    try {
      await onSubmit(value());
      if (!initialContent && editorRef.current) {
        editorRef.current.innerHTML = '';
        setEmpty(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '记录失败，请重试');
    } finally {
      setSending(false);
    }
  }

  function format(command: string) {
    editorRef.current?.focus();
    document.execCommand(command);
    syncEmpty();
  }

  function appendTranscript(text: string) {
    const editor = editorRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode))
      placeCaretAtEnd(editor);
    document.execCommand('insertText', false, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function convertToDocument() {
    if (!onConvertToDocument || !hasContent()) return;
    setSending(true);
    setError('');
    try {
      await onConvertToDocument(value());
      if (!initialContent && editorRef.current) {
        editorRef.current.innerHTML = '';
        setEmpty(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '转换失败，请重试');
    } finally {
      setSending(false);
    }
  }

  function startVoice() {
    if (recognitionRef.current) return;
    const constructor =
      (
        window as unknown as {
          SpeechRecognition?: SpeechConstructor;
          webkitSpeechRecognition?: SpeechConstructor;
        }
      ).SpeechRecognition ??
      (
        window as unknown as {
          webkitSpeechRecognition?: SpeechConstructor;
        }
      ).webkitSpeechRecognition;
    if (!constructor) {
      setError('当前浏览器不支持语音输入');
      return;
    }
    const recognition = new constructor();
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      let text = '';
      for (
        let index = event.resultIndex;
        index < event.results.length;
        index += 1
      ) {
        const result = event.results[index];
        if (result?.isFinal) text += result[0]?.transcript ?? '';
      }
      if (text) appendTranscript(text);
    };
    recognition.onerror = () => {
      setError('无法使用麦克风，请检查浏览器权限');
      recognitionRef.current = null;
      setListening(false);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
      setError('');
    } catch {
      recognitionRef.current = null;
      setError('无法启动语音输入，请稍后重试');
    }
  }

  function stopVoice() {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }

  function toggleVoice() {
    if (listening) stopVoice();
    else startVoice();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className={styles.composer} data-compact={compact || undefined}>
      <div
        ref={editorRef}
        className={styles.content}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="随想内容"
        data-placeholder={placeholder}
        onInput={() => {
          syncEmpty();
          if (error) setError('');
        }}
        onKeyDown={handleKeyDown}
      />
      <div className={styles.footer}>
        <div className={styles.tools}>
          <IconButton
            label="粗体"
            size="sm"
            tooltipPlacement="top"
            icon={<Bold size={14} />}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => format('bold')}
          />
          <IconButton
            label="斜体"
            size="sm"
            tooltipPlacement="top"
            icon={<Italic size={14} />}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => format('italic')}
          />
          <IconButton
            label="列表"
            size="sm"
            tooltipPlacement="top"
            icon={<List size={14} />}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => format('insertUnorderedList')}
          />
          {onConvertToDocument && !empty ? (
            <>
              <span className={styles.toolDivider} />
              <IconButton
                label="转为文档"
                size="sm"
                tooltipPlacement="top"
                disabled={sending}
                icon={<FilePlus2 size={14} />}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void convertToDocument()}
              />
            </>
          ) : null}
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.voice}
            data-listening={listening || undefined}
            aria-label={listening ? '停止语音输入' : '语音输入'}
            title={listening ? '停止语音输入' : '语音输入 · 长按 Fn'}
            onClick={toggleVoice}
          >
            {listening ? (
              <>
                <span className={styles.wave} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <span className={styles.voiceLabel}>录入中</span>
              </>
            ) : (
              <Mic size={14} strokeWidth={1.7} />
            )}
          </button>
          {onCancel ? (
            <Button variant="ghost" onClick={onCancel}>
              取消
            </Button>
          ) : null}
          <Button
            variant="primary"
            disabled={sending || (empty && !initialContent)}
            onClick={() => void submit()}
          >
            {sending ? '正在记录…' : submitLabel}
          </Button>
        </div>
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
