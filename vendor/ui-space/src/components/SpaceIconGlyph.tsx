import { spaceIconOptions } from './space-icons';

export function SpaceIconGlyph({
  name,
  size = 16,
  strokeWidth = 1.7,
}: {
  name?: string;
  size?: number;
  strokeWidth?: number;
}) {
  const option = spaceIconOptions.find((item) => item.id === name);
  if (!option) return null;
  const Icon = option.icon;
  return <Icon size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
}
