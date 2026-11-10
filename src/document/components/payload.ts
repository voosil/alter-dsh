/**
 * Client helpers for declarative component payloads.
 *
 * The catalog (ids, prop schemas, defaults) lives in `@alter/protocol`; this
 * module only reads payloads out of `object.get` records, builds default
 * payloads for insertion and surfaces catalog validation errors to the forms.
 *
 * @module @alter-dsh/space/document/components/payload
 */
import {
  COMPONENT_PAYLOAD_FORMAT,
  getComponentDefinition,
  validateComponentPayload,
  type ComponentPayload,
  type JsonValue,
} from '@alter/protocol';

/** Read a component payload out of one `object.get` record, if it is one. */
export function componentPayloadOf(
  record: unknown,
): ComponentPayload | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const payload = (record as Record<string, unknown>)['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    return undefined;
  const candidate = payload as Record<string, unknown>;
  if (candidate['format'] !== COMPONENT_PAYLOAD_FORMAT) return undefined;
  if (typeof candidate['componentId'] !== 'string') return undefined;
  if (typeof candidate['componentVersion'] !== 'number') return undefined;
  const props = candidate['props'];
  if (typeof props !== 'object' || props === null || Array.isArray(props))
    return undefined;
  return payload as unknown as ComponentPayload;
}

/** Deep-clone the JSON defaults of one catalog component. */
function cloneProps(
  defaults: Record<string, JsonValue>,
): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(defaults)) as Record<string, JsonValue>;
}

/** Build the default payload used when inserting one catalog component. */
export function createDefaultComponentPayload(
  componentId: string,
): ComponentPayload | undefined {
  const definition = getComponentDefinition(componentId);
  if (definition === undefined) return undefined;
  return {
    format: COMPONENT_PAYLOAD_FORMAT,
    componentId: definition.id,
    componentVersion: definition.version,
    props: cloneProps(definition.defaults),
  };
}

/** Catalog validation errors of one payload (empty array = valid). */
export function componentPayloadErrors(payload: ComponentPayload): string[] {
  return validateComponentPayload(payload);
}
