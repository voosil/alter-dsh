/**
 * Declarative component catalog (P4).
 *
 * A component block stores only an immutable instance payload
 * (`alter-component/1`): a catalog id, the fixed catalog version and a small
 * props object. Renderers are built into the browser bundle; the document
 * never carries executable code, so no sandbox is involved for v1.
 *
 * The catalog is shared by the Host (payload validation, Agent catalog tool)
 * and the browser (picker, props editor, preview) so prop schemas and the
 * AI-writable capability cannot drift.
 *
 * @module @alter/protocol/components
 */

/** JSON value accepted by component props and defaults. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Declarative prop types a built-in component can declare. */
export type ComponentPropType = 'string' | 'number' | 'stringList';

/** One prop of a component definition. */
export interface ComponentPropSpec {
  type: ComponentPropType;
  /** Human-readable field label (browser form + Agent catalog). */
  label: string;
  required?: boolean;
  /** Maximum string length (`string`) or item length (`stringList`). */
  maxLength?: number;
  /** Inclusive numeric bounds (`number`). */
  min?: number;
  max?: number;
  /** Maximum number of items (`stringList`). */
  maxItems?: number;
  /** Maximum length of one list item (`stringList`). */
  itemMaxLength?: number;
}

/** One safe, built-in component the document may reference. */
export interface ComponentDefinition {
  /** Stable catalog id, e.g. `builtin/progress`. */
  id: string;
  name: string;
  description: string;
  /** Fixed spec version; payloads must reference exactly this version. */
  version: number;
  props: Record<string, ComponentPropSpec>;
  defaults: Record<string, JsonValue>;
  /** Props the Agent may write through `space_object_update`. */
  aiWritable: string[];
}

/** Instance payload stored in the document object side table. */
export interface ComponentPayload {
  format: 'alter-component/1';
  componentId: string;
  componentVersion: number;
  props: Record<string, JsonValue>;
}

/** Serialized format tag of one component instance payload. */
export const COMPONENT_PAYLOAD_FORMAT = 'alter-component/1';

/**
 * The built-in safe component catalog.
 *
 * The list is the only set of components a document can reference in v1;
 * adding a component is a code change on both Host and browser (renderer +
 * catalog entry), never a document payload.
 */
export const COMPONENT_CATALOG: readonly ComponentDefinition[] = [
  {
    id: 'builtin/progress',
    name: '进度',
    description: '展示一个 0–100 的进度条与标题。',
    version: 1,
    props: {
      label: {
        type: 'string',
        label: '标题',
        required: true,
        maxLength: 80,
      },
      value: {
        type: 'number',
        label: '进度',
        required: true,
        min: 0,
        max: 100,
      },
    },
    defaults: { label: '任务进度', value: 60 },
    aiWritable: ['label', 'value'],
  },
  {
    id: 'builtin/checklist',
    name: '清单',
    description: '展示可勾选的检查清单（勾选状态仅本地，不写入文档）。',
    version: 1,
    props: {
      title: {
        type: 'string',
        label: '标题',
        required: true,
        maxLength: 80,
      },
      items: {
        type: 'stringList',
        label: '清单项',
        required: true,
        maxItems: 20,
        itemMaxLength: 120,
      },
    },
    defaults: { title: '检查清单', items: ['第一项'] },
    aiWritable: ['title', 'items'],
  },
  {
    id: 'builtin/stat',
    name: '指标',
    description: '展示一个核心指标及其说明。',
    version: 1,
    props: {
      label: {
        type: 'string',
        label: '标题',
        required: true,
        maxLength: 80,
      },
      value: {
        type: 'string',
        label: '数值',
        required: true,
        maxLength: 40,
      },
      hint: {
        type: 'string',
        label: '说明',
        maxLength: 120,
      },
    },
    defaults: { label: '核心指标', value: '42', hint: '较昨日 +5' },
    aiWritable: ['label', 'value', 'hint'],
  },
];

/** Look up one built-in component definition by its stable id. */
export function getComponentDefinition(
  id: string,
): ComponentDefinition | undefined {
  return COMPONENT_CATALOG.find((definition) => definition.id === id);
}

/** Whether a value is a plain JSON object (not an array/null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return true;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
  if (isPlainObject(value))
    return Object.values(value).every((item) => isJsonValue(item));
  return false;
}

function validateProp(
  componentId: string,
  key: string,
  spec: ComponentPropSpec,
  value: unknown,
): string[] {
  const label = `${spec.label}（${key}）`;
  if (value === undefined || value === null) {
    return spec.required ? [`组件 ${componentId} 的属性 ${label} 必填`] : [];
  }
  const errors: string[] = [];
  if (spec.type === 'string') {
    if (typeof value !== 'string') return [`属性 ${label} 必须是字符串`];
    // An empty optional string is treated as "not set"; required strings must
    // carry a visible value.
    if (value.trim() === '')
      return spec.required ? [`属性 ${label} 不能为空`] : [];
    if (spec.maxLength !== undefined && value.length > spec.maxLength)
      errors.push(`属性 ${label} 超过长度上限 ${spec.maxLength}`);
    return errors;
  }
  if (spec.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      return [`属性 ${label} 必须是数字`];
    if (spec.min !== undefined && value < spec.min)
      errors.push(`属性 ${label} 不能小于 ${spec.min}`);
    if (spec.max !== undefined && value > spec.max)
      errors.push(`属性 ${label} 不能大于 ${spec.max}`);
    return errors;
  }
  // stringList
  if (!Array.isArray(value)) return [`属性 ${label} 必须是字符串数组`];
  if (spec.required && value.length === 0)
    errors.push(`属性 ${label} 至少需要 1 项`);
  if (spec.maxItems !== undefined && value.length > spec.maxItems)
    errors.push(`属性 ${label} 最多 ${spec.maxItems} 项`);
  value.forEach((item, index) => {
    if (typeof item !== 'string') {
      errors.push(`属性 ${label} 的第 ${index + 1} 项必须是字符串`);
      return;
    }
    if (spec.itemMaxLength !== undefined && item.length > spec.itemMaxLength)
      errors.push(
        `属性 ${label} 的第 ${index + 1} 项超过长度上限 ${spec.itemMaxLength}`,
      );
  });
  return errors;
}

/**
 * Validate one untrusted component instance payload against the catalog.
 *
 * Returns every violation as a readable message (empty array = valid). Host
 * callers fail closed with `object/invalid`; the browser form shows the first
 * message instead of saving.
 */
export function validateComponentPayload(payload: unknown): string[] {
  if (!isPlainObject(payload)) return ['component payload 必须是对象'];
  if (payload['format'] !== COMPONENT_PAYLOAD_FORMAT)
    return [`component payload 的 format 必须是 ${COMPONENT_PAYLOAD_FORMAT}`];
  const componentId = payload['componentId'];
  if (typeof componentId !== 'string' || componentId.trim() === '')
    return ['componentId 必须是非空字符串'];
  const definition = getComponentDefinition(componentId);
  if (definition === undefined) return [`未知组件：${componentId}`];
  const version = payload['componentVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version))
    return ['componentVersion 必须是整数'];
  if (version !== definition.version)
    return [
      `组件 ${componentId} 的版本不受支持：${version}（当前 ${definition.version}）`,
    ];
  const props = payload['props'];
  if (!isPlainObject(props)) return ['component props 必须是对象'];
  const errors: string[] = [];
  for (const key of Object.keys(props)) {
    if (definition.props[key] === undefined)
      errors.push(`组件 ${componentId} 不支持属性 ${key}`);
  }
  for (const [key, spec] of Object.entries(definition.props)) {
    const value = props[key];
    if (value !== undefined && !isJsonValue(value))
      errors.push(`属性 ${spec.label}（${key}）必须是 JSON 值`);
    else errors.push(...validateProp(componentId, key, spec, value));
  }
  return errors;
}
