// 主题相关的工具函数

type Theme = 'dark' | 'light';

// 根据主题返回不同的className
export function themeClass(theme: Theme, darkClass: string, lightClass: string): string {
  return theme === 'dark' ? darkClass : lightClass;
}

// 常用的主题样式组合
export const themeStyles = {
  // 背景色
  bg: {
    primary: (theme: Theme) => theme === 'dark' ? 'bg-neutral-900' : 'bg-white',
    secondary: (theme: Theme) => theme === 'dark' ? 'bg-neutral-800' : 'bg-neutral-100',
    tertiary: (theme: Theme) => theme === 'dark' ? 'bg-neutral-700' : 'bg-neutral-200',
    sidebar: (theme: Theme) => theme === 'dark' ? 'bg-black' : 'bg-white',
  },
  
  // 文字颜色
  text: {
    primary: (theme: Theme) => theme === 'dark' ? 'text-white' : 'text-neutral-900',
    secondary: (theme: Theme) => theme === 'dark' ? 'text-neutral-200' : 'text-neutral-800',
    tertiary: (theme: Theme) => theme === 'dark' ? 'text-neutral-300' : 'text-neutral-700',
    muted: (theme: Theme) => theme === 'dark' ? 'text-neutral-400' : 'text-neutral-600',
    disabled: (theme: Theme) => theme === 'dark' ? 'text-neutral-500' : 'text-neutral-500',
  },
  
  // 边框颜色
  border: {
    primary: (theme: Theme) => theme === 'dark' ? 'border-neutral-800' : 'border-neutral-200',
    secondary: (theme: Theme) => theme === 'dark' ? 'border-neutral-700' : 'border-neutral-300',
    tertiary: (theme: Theme) => theme === 'dark' ? 'border-neutral-600' : 'border-neutral-400',
  },
  
  // hover状态
  hover: {
    bg: (theme: Theme) => theme === 'dark' ? 'hover:bg-neutral-800' : 'hover:bg-neutral-100',
    bgSecondary: (theme: Theme) => theme === 'dark' ? 'hover:bg-neutral-700' : 'hover:bg-neutral-200',
    text: (theme: Theme) => theme === 'dark' ? 'hover:text-white' : 'hover:text-neutral-900',
    textSecondary: (theme: Theme) => theme === 'dark' ? 'hover:text-neutral-200' : 'hover:text-neutral-800',
  },
  
  // 输入框
  input: {
    bg: (theme: Theme) => theme === 'dark' ? 'bg-neutral-800' : 'bg-white',
    border: (theme: Theme) => theme === 'dark' ? 'border-neutral-700' : 'border-neutral-300',
    text: (theme: Theme) => theme === 'dark' ? 'text-neutral-200' : 'text-neutral-800',
    placeholder: (theme: Theme) => 'placeholder:text-neutral-500',
  },
  
  // 弹出层
  popover: {
    bg: (theme: Theme) => theme === 'dark' ? 'bg-neutral-800' : 'bg-white',
    border: (theme: Theme) => theme === 'dark' ? 'border-neutral-700' : 'border-neutral-300',
  },
  
  // 卡片
  card: {
    bg: (theme: Theme) => theme === 'dark' ? 'bg-neutral-800/50' : 'bg-neutral-100',
    bgHover: (theme: Theme) => theme === 'dark' ? 'hover:bg-neutral-800' : 'hover:bg-neutral-200',
    border: (theme: Theme) => theme === 'dark' ? 'border-neutral-700' : 'border-neutral-300',
  },
};
