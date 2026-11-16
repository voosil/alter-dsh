import { createContext, useContext } from 'react';
import type {
  Agent,
  Space,
  SpaceNode,
  SpaceService,
  Thought,
} from '@alter/protocol';
import type { SpaceRouter } from './types';

export interface SpaceContextValue {
  /**
   * 这个空间视图渲染在 DSH 右栏的标签里（「空间页面」标签）。嵌入时不再给
   * 「右侧栏」开关：右栏本来就是展开的，点它只会把自己所在的列收起来。
   */
  embedded?: boolean;
  workbench?: {
    controller: import('@alter/ui-workbench').WorkbenchController;
    scopeKey: string;
  };
  openWeb?: (url: string) => void;
  service: SpaceService;
  router: SpaceRouter;
  spaces: Space[];
  agents: Agent[];
  space: Space;
  spaceId: string;
  nodes: SpaceNode[];
  thoughts: Thought[];
  version: number;
  refresh: () => void;
  toast: (message: string) => void;
  openSearch: () => void;
  openThoughtComposer: () => void;
  openDirectory: () => void;
  closeDirectory: () => void;
  removeSpaceFromState: (id: string) => void;
  addSpaceToState: (space: Space) => void;
  addNodeToState: (node: SpaceNode) => void;
  updateNodeInState: (node: SpaceNode) => void;
}

export const SpaceContext = createContext<SpaceContextValue | null>(null);

export function useSpaceContext() {
  const context = useContext(SpaceContext);
  if (!context) throw new Error('Space context is unavailable');
  return context;
}
