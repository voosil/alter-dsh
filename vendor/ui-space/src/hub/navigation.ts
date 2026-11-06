import { useSpaceContext } from '../runtime';
export function useHubNavigation() {
  const { workbench, service, spaceId, refresh, toast } = useSpaceContext();
  return {
    async openMatter(id: string) {
      if (!workbench) {
        toast('Workbench 暂不可用');
        return;
      }
      const data = await service.hub.get(spaceId);
      const matter = data.matters.find((item) => item.id === id);
      if (!matter) return;
      workbench.controller.launch(workbench.scopeKey, 'resource', {
        resourceType: 'matter',
        resourceId: id,
        title: matter.title,
      });
      try {
        await service.hub.readMatter(spaceId, id);
        refresh();
      } catch {
        toast('阅读状态未保存，请稍后重试');
      }
    },
    openConversation(
      purpose: 'introduction' | 'plugin' | 'skill',
      entityId?: string,
    ) {
      if (!workbench) {
        toast('Workbench 暂不可用');
        return;
      }
      const existing = workbench.controller
        .getScope(workbench.scopeKey)
        .tabs.find(
          (tab) => tab.chatPurpose === purpose && tab.entityId === entityId,
        );
      if (existing) {
        workbench.controller.select(workbench.scopeKey, existing.id);
        if (!workbench.controller.getScope(workbench.scopeKey).open)
          workbench.controller.toggle(workbench.scopeKey);
        return;
      }
      workbench.controller.launch(workbench.scopeKey, 'chat', {
        chatPurpose: purpose,
        entityId,
        title: {
          introduction: '聊聊这个空间',
          plugin: '创建插件',
          skill: '技能提炼',
        }[purpose],
      });
    },
  };
}
