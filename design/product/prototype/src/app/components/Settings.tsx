import { useState } from 'react';
import { ChevronLeft, ChevronRight, User, Shield, Zap, PanelLeftClose, X } from 'lucide-react';
import { GeneralSettings } from './settings/GeneralSettings';
import { PrivacySettings } from './settings/PrivacySettings';
import { CapabilitiesSettings } from './settings/CapabilitiesSettings';
import { useTheme } from '../contexts/ThemeContext';
import { themeStyles } from '../utils/theme';

interface SettingsProps {
  onBack: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
}

type SettingsSection = 'general' | 'privacy' | 'capabilities';

export function Settings({ 
  onBack, 
  sidebarCollapsed, 
  onToggleSidebar, 
  onGoBack, 
  onGoForward, 
  canGoBack, 
  canGoForward 
}: SettingsProps) {
  const { theme } = useTheme();
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');

  const sections = [
    { id: 'general' as const, label: '通用', icon: User },
    { id: 'privacy' as const, label: '隐私', icon: Shield },
    { id: 'capabilities' as const, label: '能力配置', icon: Zap },
  ];

  return (
    <div className={`flex-1 flex flex-col ${themeStyles.bg.primary(theme)}`}>
      {/* 顶部标题栏 */}
      <div className={`h-12 border-b ${themeStyles.border.primary(theme)} flex items-center`}>
        {/* 左侧导航按钮 */}
        <div className="flex items-center gap-1 px-4">
          <button
            onClick={onToggleSidebar}
            className={`w-8 h-8 flex items-center justify-center ${themeStyles.hover.bg(theme)} rounded transition-colors`}
            title={sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"}
          >
            <PanelLeftClose className={`w-5 h-5 transition-transform ${sidebarCollapsed ? 'rotate-180' : ''}`} />
          </button>
          
          <button
            onClick={onGoBack}
            disabled={!canGoBack}
            className={`w-8 h-8 flex items-center justify-center ${themeStyles.hover.bg(theme)} rounded transition-colors ${
              !canGoBack ? 'opacity-30 cursor-not-allowed' : ''
            }`}
            title="后退"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          
          <button
            onClick={onGoForward}
            disabled={!canGoForward}
            className={`w-8 h-8 flex items-center justify-center ${themeStyles.hover.bg(theme)} rounded transition-colors ${
              !canGoForward ? 'opacity-30 cursor-not-allowed' : ''
            }`}
            title="前进"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        {/* 中间标题 */}
        <div className="flex-1 flex items-center justify-center">
          <h1 className="text-lg">设置</h1>
        </div>

        {/* 右侧关闭按钮 */}
        <div className="w-[188px] flex items-center justify-end pr-4">
          <button 
            onClick={onBack}
            className={`w-8 h-8 flex items-center justify-center ${themeStyles.hover.bg(theme)} rounded transition-colors`}
            title="关闭设置"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* 主要内容区域 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧导航 */}
        <div className={`w-64 border-r ${themeStyles.border.primary(theme)} overflow-y-auto`}>
          <div className="py-4">
            {sections.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={`w-full flex items-center gap-3 px-6 py-3 text-left transition-colors ${
                  activeSection === section.id
                    ? `${themeStyles.bg.secondary(theme)} ${themeStyles.text.primary(theme)}`
                    : `${themeStyles.text.secondary(theme)} ${themeStyles.hover.bgSecondary(theme)}`
                }`}
              >
                <section.icon className="w-5 h-5" />
                <span className="text-sm">{section.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 右侧设置内容 */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-8 py-8">
            {activeSection === 'general' && <GeneralSettings />}
            {activeSection === 'privacy' && <PrivacySettings />}
            {activeSection === 'capabilities' && <CapabilitiesSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}
