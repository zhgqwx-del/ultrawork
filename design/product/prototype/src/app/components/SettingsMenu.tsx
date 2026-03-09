import { useState } from 'react';
import { 
  Settings, 
  Languages, 
  Folder, 
  Brain, 
  MessageSquare, 
  Plug, 
  HelpCircle, 
  Info,
  ChevronRight,
  X,
  Check
} from 'lucide-react';
import { WorkspaceDialog } from './settings/WorkspaceDialog';
import { ModelDialog } from './settings/ModelDialog';
import { ChannelsDialog } from './settings/ChannelsDialog';
import { RemoteServiceDialog } from './settings/RemoteServiceDialog';
import { AboutDialog } from './settings/AboutDialog';
import { useTheme } from '../contexts/ThemeContext';
import { themeStyles } from '../utils/theme';

interface SettingsMenuProps {
  onClose: () => void;
  onOpenFullSettings: () => void;
}

export function SettingsMenu({ onClose, onOpenFullSettings }: SettingsMenuProps) {
  const { theme } = useTheme();
  const [activeDialog, setActiveDialog] = useState<string | null>(null);
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const [selectedLanguage, setSelectedLanguage] = useState('zh-CN');

  const menuItems = [
    { id: 'settings', icon: Settings, label: '设置', hasSubmenu: false, type: 'fullpage' },
    { id: 'language', icon: Languages, label: '语言切换', hasSubmenu: true, type: 'cascade' },
    { id: 'workspace', icon: Folder, label: '工作目录', hasSubmenu: true, type: 'dialog' },
    { id: 'model', icon: Brain, label: '模型（供应商）', hasSubmenu: true, type: 'dialog' },
    { id: 'channels', icon: MessageSquare, label: '消息通道', hasSubmenu: true, type: 'dialog' },
    { id: 'remote', icon: Plug, label: '远程服务连接', hasSubmenu: true, type: 'dialog' },
    { id: 'help', icon: HelpCircle, label: '帮助文档', hasSubmenu: false, type: 'normal' },
    { id: 'about', icon: Info, label: '关于我们', hasSubmenu: true, type: 'dialog' },
  ];

  const languages = [
    { code: 'zh-CN', name: '简体中文', englishName: 'Simplified Chinese' },
    { code: 'en', name: 'English', englishName: 'English' },
  ];

  const handleItemClick = (itemId: string, type: string) => {
    if (type === 'fullpage') {
      onOpenFullSettings();
    } else if (type === 'dialog') {
      setActiveDialog(itemId);
      setHoveredItem(null);
    } else if (itemId === 'help') {
      window.open('https://docs.example.com', '_blank');
    }
  };

  const handleLanguageSelect = (langCode: string) => {
    setSelectedLanguage(langCode);
    setHoveredItem(null);
  };

  return (
    <>
      <div className="py-2 relative">
        <div className={`px-4 py-3 border-b ${themeStyles.border.primary(theme)} flex items-center justify-between`}>
          <h3 className="text-sm font-medium text-[#fafffed1]">映卿的助手</h3>
          <button 
            onClick={onClose}
            className={`${themeStyles.hover.bg(theme)} p-1 rounded transition-colors`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="py-1">
          {menuItems.map((item) => (
            <div
              key={item.id}
              className="relative"
              onMouseEnter={() => item.type === 'cascade' && setHoveredItem(item.id)}
              onMouseLeave={() => item.type === 'cascade' && setHoveredItem(null)}
            >
              <button
                onClick={() => handleItemClick(item.id, item.type)}
                className={`w-full flex items-center justify-between px-4 py-2.5 ${themeStyles.hover.bg(theme)} transition-colors text-left`}
              >
                <div className="flex items-center gap-3">
                  <item.icon className={`w-4 h-4 ${themeStyles.text.muted(theme)}`} />
                  <span className={`text-sm ${themeStyles.text.primary(theme)}`}>{item.label}</span>
                </div>
                {item.hasSubmenu && (
                  <ChevronRight className={`w-4 h-4 ${themeStyles.text.disabled(theme)}`} />
                )}
              </button>

              {/* 级联语言菜单 */}
              {item.id === 'language' && hoveredItem === 'language' && (
                <div 
                  className={`absolute left-full top-0 ml-1 w-64 ${themeStyles.popover.bg(theme)} border ${themeStyles.popover.border(theme)} rounded-lg shadow-xl z-50`}
                  onMouseEnter={() => setHoveredItem('language')}
                  onMouseLeave={() => setHoveredItem(null)}
                >
                  <div className="py-2">
                    <div className={`px-3 py-2 border-b ${themeStyles.border.primary(theme)}`}>
                      <h4 className={`text-xs font-medium ${themeStyles.text.muted(theme)}`}>选择语言</h4>
                    </div>
                    {languages.map((lang) => (
                      <button
                        key={lang.code}
                        onClick={() => handleLanguageSelect(lang.code)}
                        className={`w-full flex items-center justify-between px-3 py-2.5 ${themeStyles.hover.bg(theme)} transition-colors`}
                      >
                        <div className="flex flex-col items-start">
                          <span className="text-sm font-medium text-white">{lang.name}</span>
                          <span className={`text-xs ${themeStyles.text.muted(theme)}`}>{lang.englishName}</span>
                        </div>
                        {selectedLanguage === lang.code && (
                          <Check className="w-4 h-4 text-green-500" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 子对话框 */}
      <WorkspaceDialog 
        open={activeDialog === 'workspace'} 
        onOpenChange={(open) => { if (!open) setActiveDialog(null); }} 
      />
      <ModelDialog 
        open={activeDialog === 'model'} 
        onOpenChange={(open) => { if (!open) setActiveDialog(null); }} 
      />
      <ChannelsDialog 
        open={activeDialog === 'channels'} 
        onOpenChange={(open) => { if (!open) setActiveDialog(null); }} 
      />
      <RemoteServiceDialog 
        open={activeDialog === 'remote'} 
        onOpenChange={(open) => { if (!open) setActiveDialog(null); }} 
      />
      <AboutDialog 
        open={activeDialog === 'about'} 
        onOpenChange={(open) => { if (!open) setActiveDialog(null); }} 
      />
    </>
  );
}
