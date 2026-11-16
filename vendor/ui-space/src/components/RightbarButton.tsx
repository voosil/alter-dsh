import { PanelRight } from 'lucide-react';
import { IconButton } from '@alter/ui-system';
import { useSpaceContext } from '../runtime';
import { uiBridge } from '../bridge';

/**
 * 空间主界面右上角的「右侧栏」开关。
 *
 * 它就是 DSH 对话页那个右侧栏（`bridge.toggleRightbar`），不是空间自建的第二个
 * 面板；图标、悬停提示、展开/收起行为与对话页同名控件一致。桥会把一个对话带到
 * 主区再展开右栏，回答 `unavailable` 时这里行内说明原因，不留一个点了没反应的
 * 按钮。嵌入在右栏标签里的空间视图不渲染它：右栏本来就是展开的，点它只会把
 * 自己所在的列收起来。
 *
 * @param props.nodeId - 当前打开的页面；非页面态（概览、首页等）不传。
 * @param props.embedded - 显式声明嵌入态；缺省跟随 Space 上下文。
 */
export function RightbarButton({
  nodeId,
  embedded,
}: {
  nodeId?: string;
  embedded?: boolean;
} = {}) {
  const { spaceId, embedded: contextEmbedded, toast } = useSpaceContext();
  const bridge = uiBridge();
  if (embedded ?? contextEmbedded ?? false) return null;
  return (
    <IconButton
      label="展开/收起右侧栏"
      tooltip="右侧栏"
      icon={<PanelRight />}
      disabled={bridge === null}
      onClick={() => {
        // 桥会在需要时先把一个对话带到主区，再把页面放进右栏；失败原因由它
        // 回答，读者始终知道开关为什么没反应。
        void Promise.resolve(
          bridge?.toggleRightbar({ spaceId, ...(nodeId === undefined ? {} : { nodeId }) }),
        ).then((outcome) => {
          if (outcome === 'unavailable')
            toast('右侧栏需要对话视图；请在左侧会话列表打开一个对话后重试');
        });
      }}
    />
  );
}
