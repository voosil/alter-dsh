/**
 * Public surface of the declarative component views (P4).
 *
 * @module @alter-dsh/space/document/components
 */
export {
  COMPONENT_EDIT_EVENT,
  type ComponentEditRequest,
} from './events';
export {
  clearComponentObjectStates,
  getComponentObjectState,
  setComponentObjectState,
  subscribeComponentObjectStates,
  useComponentObjectState,
  type ComponentObjectState,
} from './object-store';
export {
  componentPayloadErrors,
  componentPayloadOf,
  createDefaultComponentPayload,
} from './payload';
export {
  ChecklistComponent,
  COMPONENT_RENDERERS,
  ProgressComponent,
  StatComponent,
  type ComponentProps,
  type ComponentRenderProps,
} from './renderers';
export {
  ComponentFallbackCard,
  ComponentRenderer,
} from './registry';
export { ComponentPicker, type ComponentPickerProps } from './ComponentPicker';
export { PropsEditor, type PropsEditorProps } from './PropsEditor';
