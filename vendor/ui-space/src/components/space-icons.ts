import {
  BookOpen,
  Boxes,
  Compass,
  Globe2,
  Layers,
  Lightbulb,
  Sparkles,
  Target,
  type LucideIcon,
} from 'lucide-react';

export interface SpaceIconOption {
  id: string;
  label: string;
  icon: LucideIcon;
}

export const spaceIconOptions: SpaceIconOption[] = [
  { id: 'layers', label: '层叠', icon: Layers },
  { id: 'compass', label: '罗盘', icon: Compass },
  { id: 'target', label: '目标', icon: Target },
  { id: 'lightbulb', label: '灵感', icon: Lightbulb },
  { id: 'book', label: '阅读', icon: BookOpen },
  { id: 'sparkles', label: '星芒', icon: Sparkles },
  { id: 'boxes', label: '容器', icon: Boxes },
  { id: 'globe', label: '世界', icon: Globe2 },
];

export const spaceColorOptions = [
  { id: 'ink', label: '墨色', value: '#4c4e53' },
  { id: 'blue', label: '蓝色', value: '#4f6b8a' },
  { id: 'green', label: '绿色', value: '#5f7355' },
  { id: 'orange', label: '橙色', value: '#ad3c17' },
  { id: 'rose', label: '玫红', value: '#9c5b5b' },
  { id: 'purple', label: '紫色', value: '#6b5f7d' },
];
