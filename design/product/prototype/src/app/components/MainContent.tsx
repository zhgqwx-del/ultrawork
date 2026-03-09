import { ChevronDown, Folder, Settings, ChevronLeft, ChevronRight, PanelLeftClose, FolderOpen, FileText, BarChart3, ArrowRight, Plus, Check, Paperclip, Blocks, Zap, Puzzle, ChevronRight as ChevronRightIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { useState, useEffect, useRef } from 'react';
import { ModelDialog } from './settings/ModelDialog';
import { useTheme } from '../contexts/ThemeContext';
import { themeStyles } from '../utils/theme';

interface MainContentProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface AbilityCard {
  id: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  prompts: string[];
}

export function MainContent({ 
  sidebarCollapsed, 
  onToggleSidebar, 
  onGoBack, 
  onGoForward, 
  canGoBack, 
  canGoForward 
}: MainContentProps) {
  const { theme } = useTheme();
  const [isWorkspacePopoverOpen, setIsWorkspacePopoverOpen] = useState(false);
  const [isModelPopoverOpen, setIsModelPopoverOpen] = useState(false);
  const [isThinkingPopoverOpen, setIsThinkingPopoverOpen] = useState(false);
  const [isModelDialogOpen, setIsModelDialogOpen] = useState(false);
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const [showTooltip, setShowTooltip] = useState(false);
  const [selectedAbility, setSelectedAbility] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [selectedModel, setSelectedModel] = useState('Qwen3.5 plus@Alibaba');
  const [selectedThinking, setSelectedThinking] = useState('标准');
  const [deepThinkingEnabled, setDeepThinkingEnabled] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollPosition, setScrollPosition] = useState(0);

  const models = [
    { name: 'Qwen3.5 plus@Alibaba', provider: 'Alibaba' },
    { name: 'GPT-4@OpenAI', provider: 'OpenAI' },
    { name: 'Claude 3@Anthropic', provider: 'Anthropic' },
    { name: 'Gemini Pro@Google', provider: 'Google' },
  ];

  const thinkingModes = [
    { name: '标准', description: '平衡速度和质量' },
    { name: '快速', description: '更快的响应速度' },
    { name: '深度', description: '更详细的分析' },
    { name: '创意', description: '更有创造性的回答' },
  ];

  // MCP服务列表
  const [mcpServices, setMcpServices] = useState([
    { id: 'chrome', name: 'Control Chrome', icon: '🌐', enabled: true },
    { id: 'gaode', name: '高德地图', icon: '🗺️', enabled: true },
    { id: 'calendar', name: '日历服务', icon: '📅', enabled: true },
    { id: 'weather', name: '天气服务', icon: '🌤️', enabled: false },
  ]);

  // 技能列表
  const [skills, setSkills] = useState([
    { id: 'disk-clean', name: '磁盘清理', icon: '🧹', enabled: true },
    { id: 'daily-news', name: '每日新闻', icon: '📰', enabled: true },
    { id: 'system-monitor', name: '系统监控', icon: '📊', enabled: false },
    { id: 'file-backup', name: '文件备份', icon: '💾', enabled: false },
  ]);

  // 插件列表
  const [plugins, setPlugins] = useState([
    { id: 'translator', name: '翻译助手', icon: '🌍', enabled: true },
    { id: 'code-formatter', name: '代码格式化', icon: '💻', enabled: true },
    { id: 'screenshot', name: '截图工具', icon: '📸', enabled: false },
    { id: 'markdown', name: 'Markdown编辑器', icon: '📝', enabled: false },
  ]);

  // 排序函数：已启用的在前面
  const sortByEnabled = <T extends { enabled: boolean }>(items: T[]) => {
    return [...items].sort((a, b) => {
      if (a.enabled === b.enabled) return 0;
      return a.enabled ? -1 : 1;
    });
  };

  // 切换服务/技能/插件状态
  const toggleMcpService = (id: string) => {
    setMcpServices(prev => prev.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s));
  };

  const toggleSkill = (id: string) => {
    setSkills(prev => prev.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s));
  };

  const togglePlugin = (id: string) => {
    setPlugins(prev => prev.map(p => p.id === id ? { ...p, enabled: !p.enabled } : p));
  };

  // 处理鼠标移动
  const handleMouseMove = (e: React.MouseEvent) => {
    setTooltipPosition({ x: e.clientX, y: e.clientY });
  };

  const abilities: AbilityCard[] = [
    {
      id: 'file-management',
      title: '文件整理',
      description: '智能整理和管理本地文件',
      icon: FolderOpen,
      prompts: [
        '读取『会议记录』文件夹中本周的所有会议记录，提取关键决策和行动项，生成一份本周会议要点总结文档。',
        '从『参考文献』文件夹中的20篇 PDF 论文中提取标题、作者、发表年份、摘要和关键词，生成规范的参考文献列表。',
        '将『提案文件』文件夹中的10份 Word 文档统一调整为：标题宋体加粗18号、正文宋体12号、1.5倍行距、首行缩进2字符。'
      ]
    },
    {
      id: 'content-creation',
      title: '内容创作',
      description: '创作演示文稿、文档和多媒体内容',
      icon: FileText,
      prompts: [
        '基于市场调研报告创���一个产品发布演示文稿，包含市场分析、产品特性和竞争优势。',
        '撰写一篇技术博客文章，介绍最新的AI技术趋势和应用案例。',
        '设计一份项目提案文档，包含项目背景、目标、实施计划和预期成果。'
      ]
    },
    {
      id: 'document-processing',
      title: '文档处理',
      description: '处理和分析文档数据',
      icon: BarChart3,
      prompts: [
        '分析销售数据表格，生成月度销售报告和趋势图表。',
        '从合同文档中提取关键条款和截止日期，创建跟踪表。',
        '汇总多个部门的季度报告，生成公司整体业绩总结。'
      ]
    }
  ];

  const handleAbilityClick = (abilityId: string) => {
    setSelectedAbility(selectedAbility === abilityId ? null : abilityId);
    setScrollPosition(0); // 重置滚动位置
  };

  const handlePromptClick = (prompt: string) => {
    setInputValue(prompt);
    setSelectedAbility(null);
  };

  // 自动滚动效果
  useEffect(() => {
    if (!selectedAbility || !scrollContainerRef.current) return;

    const container = scrollContainerRef.current;
    const scrollHeight = container.scrollHeight;
    const clientHeight = container.clientHeight;
    
    if (scrollHeight <= clientHeight) return; // 内容不足，不需要滚动

    const interval = setInterval(() => {
      setScrollPosition(prev => {
        const maxScroll = scrollHeight - clientHeight;
        const newPosition = prev + 0.5; // 缓慢滚动
        
        // 如果到达底部，重置到顶部
        if (newPosition >= maxScroll) {
          return 0;
        }
        return newPosition;
      });
    }, 30); // 每30ms更新一次

    return () => clearInterval(interval);
  }, [selectedAbility]);

  // 应用滚动位置
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollPosition;
    }
  }, [scrollPosition]);

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
          
        </div>

        {/* 右侧占位，保持标题居中 */}
        <div className="w-[140px]"></div>
      </div>

      {/* 主要内容区域 */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 py-12">
        {/* 标题 */}
        <div className="text-center mb-12">
          <h2 className="text-4xl mb-3">聊天办公，简单轻松</h2>
          <p className={`${themeStyles.text.muted(theme)} text-base`}>本地运行、智能规划、安全可控的 AI 工作搭子</p>
        </div>

        {/* 能力卡片 */}
        <div className="w-full max-w-3xl mb-8">
          <div className="grid grid-cols-3 gap-3">
            {abilities.map((ability) => (
              <button
                key={ability.id}
                onClick={() => handleAbilityClick(ability.id)}
                className={`${themeStyles.card.bg(theme)} ${themeStyles.card.bgHover(theme)} border ${themeStyles.card.border(theme)} rounded-lg p-4 text-left transition-colors ${
                  selectedAbility === ability.id ? 'ring-2 ring-orange-500' : ''
                }`}
              >
                <div className={`w-10 h-10 ${themeStyles.bg.tertiary(theme)} rounded-lg flex items-center justify-center mb-3`}>
                  <ability.icon className={`w-5 h-5 ${themeStyles.text.tertiary(theme)}`} />
                </div>
                <h3 className="text-base mb-1.5">{ability.title}</h3>
                <p className={`text-xs ${themeStyles.text.muted(theme)}`}>{ability.description}</p>
              </button>
            ))}
          </div>
        </div>

        {/* 提示词列表 - 带滚动轮播和渐变效果 */}
        {selectedAbility && (
          <div className="w-full max-w-3xl mb-6 relative">
            {/* 顶部渐变遮罩 */}
            <div className={`absolute top-0 left-0 right-0 h-12 bg-gradient-to-b ${theme === 'dark' ? 'from-neutral-900' : 'from-white'} to-transparent pointer-events-none z-10`}></div>
            
            {/* 滚动容器 */}
            <div 
              ref={scrollContainerRef}
              className={`h-[280px] overflow-hidden relative border ${themeStyles.border.primary(theme)} rounded-lg`}
            >
              <div className="space-y-2.5 p-4">
                {abilities.find(a => a.id === selectedAbility)?.prompts.map((prompt, index) => (
                  <button
                    key={index}
                    onClick={() => handlePromptClick(prompt)}
                    className={`w-full flex items-start p-3.5 ${themeStyles.card.bg(theme)} ${themeStyles.card.bgHover(theme)} border ${themeStyles.card.border(theme)} rounded-lg text-left transition-colors group`}
                  >
                    <span className={`text-sm ${themeStyles.text.tertiary(theme)} ${themeStyles.hover.text(theme)} leading-relaxed`}>{prompt}</span>
                  </button>
                ))}
                {/* 复制一份内容用于无缝循环 */}
                {abilities.find(a => a.id === selectedAbility)?.prompts.map((prompt, index) => (
                  <button
                    key={`duplicate-${index}`}
                    onClick={() => handlePromptClick(prompt)}
                    className={`w-full flex items-start p-3.5 ${themeStyles.card.bg(theme)} ${themeStyles.card.bgHover(theme)} border ${themeStyles.card.border(theme)} rounded-lg text-left transition-colors group`}
                  >
                    <span className={`text-sm ${themeStyles.text.tertiary(theme)} ${themeStyles.hover.text(theme)} leading-relaxed`}>{prompt}</span>
                  </button>
                ))}
              </div>
            </div>
            
            {/* 底部渐变遮罩 */}
            <div className={`absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t ${theme === 'dark' ? 'from-neutral-900' : 'from-white'} to-transparent pointer-events-none z-10`}></div>
          </div>
        )}

        {/* 输入框 - 按图片样式 */}
        <div className="w-full max-w-3xl">
          <div className={`${themeStyles.card.bg(theme)} border ${themeStyles.card.border(theme)} rounded-xl p-6`}>
            {/* 标题文字 */}
            <div className="mb-6">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="今天我能帮你做些什么？"
                className={`w-full bg-transparent ${themeStyles.text.secondary(theme)} text-lg outline-none ${themeStyles.input.placeholder(theme)}`}
              />
            </div>

            {/* 控制栏 */}
            <div className="flex items-center gap-3">
              {/* 目录选择器 */}
              <Popover open={isWorkspacePopoverOpen} onOpenChange={setIsWorkspacePopoverOpen}>
                <PopoverTrigger asChild>
                  <button className={`flex items-center gap-2 px-4 py-2 ${themeStyles.bg.tertiary(theme)} ${themeStyles.hover.bgSecondary(theme)} rounded-md transition-colors text-sm`}>
                    <Folder className="w-4 h-4" />
                    <span>映卿的工作目录</span>
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent 
                  side="bottom" 
                  align="start" 
                  className={`w-96 p-0 ${themeStyles.popover.bg(theme)} ${themeStyles.popover.border(theme)}`}
                  sideOffset={8}
                >
                  <div className="py-3">
                    <div className="px-4 pb-3">
                      <h4 className={`text-sm ${themeStyles.text.muted(theme)}`}>最近使用的目录</h4>
                    </div>
                    <div className="px-3">
                      <button 
                        className={`w-full ${themeStyles.card.bg(theme)} ${themeStyles.card.bgHover(theme)} rounded-lg p-3 transition-colors`}
                        onClick={() => setIsWorkspacePopoverOpen(false)}
                      >
                        <div className="flex items-center gap-3">
                          <Folder className={`w-5 h-5 ${themeStyles.text.muted(theme)}`} />
                          <div className="flex-1 text-left">
                            <p className={`text-sm ${themeStyles.text.secondary(theme)}`}>映哪的工作目录</p>
                            <p className={`text-xs ${themeStyles.text.disabled(theme)}`}>/Users/wp/w/default_workspace</p>
                          </div>
                        </div>
                      </button>
                    </div>
                    <div className="px-3 pt-3">
                      <button className={`flex items-center gap-2 px-3 py-2 text-sm ${themeStyles.text.muted(theme)} ${themeStyles.hover.text(theme)} transition-colors`}>
                        <Settings className="w-4 h-4" />
                        <span>选择其他文件夹</span>
                      </button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>

              {/* 加号按钮 - 上传附件、MCP、技能、插件 */}
              <Popover open={isAddMenuOpen} onOpenChange={(open) => {
                setIsAddMenuOpen(open);
                if (!open) setExpandedMenu(null);
              }}>
                <PopoverTrigger asChild>
                  <button className={`w-9 h-9 flex items-center justify-center ${themeStyles.hover.bgSecondary(theme)} rounded-md transition-colors`}>
                    <Plus className="w-5 h-5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent 
                  side="bottom" 
                  align="start" 
                  className={`w-72 p-0 ${themeStyles.popover.bg(theme)} ${themeStyles.popover.border(theme)}`}
                  sideOffset={8}
                >
                  <div className="py-2 relative">
                    {/* 上传附件 */}
                    <div className="relative">
                      <button 
                        className={`w-full flex items-center gap-3 px-4 py-2.5 ${themeStyles.hover.bg(theme)} transition-colors`}
                        onMouseEnter={() => setShowTooltip(true)}
                        onMouseLeave={() => setShowTooltip(false)}
                        onMouseMove={handleMouseMove}
                      >
                        <Paperclip className={`w-5 h-5 ${themeStyles.text.muted(theme)}`} />
                        <span className={`text-sm ${themeStyles.text.secondary(theme)}`}>上传附件</span>
                      </button>
                      {showTooltip && (
                        <div 
                          className={`fixed z-50 px-3 py-2 ${theme === 'dark' ? 'bg-neutral-800 border-neutral-700' : 'bg-neutral-700 border-neutral-600'} rounded-md shadow-lg pointer-events-none`}
                          style={{
                            left: `${tooltipPosition.x + 10}px`,
                            top: `${tooltipPosition.y + 10}px`,
                          }}
                        >
                          <p className="text-xs text-neutral-200 whitespace-nowrap">支持文件/图片/音频/文本等</p>
                        </div>
                      )}
                    </div>

                    {/* MCP服务 */}
                    <Popover open={expandedMenu === 'mcp'} onOpenChange={(open) => setExpandedMenu(open ? 'mcp' : null)}>
                      <PopoverTrigger asChild>
                        <button 
                          className={`w-full flex items-center gap-3 px-4 py-2.5 ${themeStyles.hover.bg(theme)} transition-colors`}
                        >
                          <Blocks className={`w-5 h-5 ${themeStyles.text.muted(theme)}`} />
                          <span className={`text-sm ${themeStyles.text.secondary(theme)} flex-1 text-left`}>MCP服务</span>
                          <ChevronRightIcon className={`w-4 h-4 ${themeStyles.text.muted(theme)}`} />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent 
                        side="right" 
                        align="start"
                        sideOffset={8}
                        className={`w-72 p-0 ${themeStyles.popover.bg(theme)} ${themeStyles.popover.border(theme)}`}
                      >
                        <div className="py-2">
                          {sortByEnabled(mcpServices).map((service) => (
                            <button 
                              key={service.id}
                              onClick={() => toggleMcpService(service.id)}
                              className={`w-full flex items-center gap-3 px-4 py-2 ${themeStyles.hover.bg(theme)} transition-colors`}
                            >
                              <span className="text-base">{service.icon}</span>
                              <span className={`text-sm flex-1 text-left ${service.enabled ? themeStyles.text.secondary(theme) : themeStyles.text.disabled(theme)}`}>
                                {service.name}
                              </span>
                              <div 
                                className={`w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
                                  service.enabled ? 'bg-orange-600' : 'bg-neutral-400'
                                }`}
                              >
                                <div 
                                  className={`w-4 h-4 rounded-full bg-white transition-transform transform ${
                                    service.enabled ? 'translate-x-4' : 'translate-x-0.5'
                                  } mt-0.5`}
                                ></div>
                              </div>
                            </button>
                          ))}
                          <div className={`border-t ${themeStyles.border.primary(theme)} mt-2 pt-2`}>
                            <button className={`w-full flex items-center gap-2 px-4 py-2 text-xs ${themeStyles.text.disabled(theme)} ${themeStyles.hover.text(theme)} transition-colors`}>
                              <Settings className="w-3.5 h-3.5" />
                              <span>管理MCP服务</span>
                            </button>
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>

                    {/* 技能 */}
                    <Popover open={expandedMenu === 'skills'} onOpenChange={(open) => setExpandedMenu(open ? 'skills' : null)}>
                      <PopoverTrigger asChild>
                        <button 
                          className={`w-full flex items-center gap-3 px-4 py-2.5 ${themeStyles.hover.bg(theme)} transition-colors`}
                        >
                          <Zap className={`w-5 h-5 ${themeStyles.text.muted(theme)}`} />
                          <span className={`text-sm ${themeStyles.text.secondary(theme)} flex-1 text-left`}>技能</span>
                          <ChevronRightIcon className={`w-4 h-4 ${themeStyles.text.muted(theme)}`} />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent 
                        side="right" 
                        align="start"
                        sideOffset={8}
                        className={`w-72 p-0 ${themeStyles.popover.bg(theme)} ${themeStyles.popover.border(theme)}`}
                      >
                        <div className="py-2">
                          {sortByEnabled(skills).map((skill) => (
                            <button 
                              key={skill.id}
                              onClick={() => toggleSkill(skill.id)}
                              className={`w-full flex items-center gap-3 px-4 py-2 ${themeStyles.hover.bg(theme)} transition-colors`}
                            >
                              <span className="text-base">{skill.icon}</span>
                              <span className={`text-sm flex-1 text-left ${skill.enabled ? themeStyles.text.secondary(theme) : themeStyles.text.disabled(theme)}`}>
                                {skill.name}
                              </span>
                              <div 
                                className={`w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
                                  skill.enabled ? 'bg-orange-600' : 'bg-neutral-400'
                                }`}
                              >
                                <div 
                                  className={`w-4 h-4 rounded-full bg-white transition-transform transform ${
                                    skill.enabled ? 'translate-x-4' : 'translate-x-0.5'
                                  } mt-0.5`}
                                ></div>
                              </div>
                            </button>
                          ))}
                          <div className={`border-t ${themeStyles.border.primary(theme)} mt-2 pt-2`}>
                            <button className={`w-full flex items-center gap-2 px-4 py-2 text-xs ${themeStyles.text.disabled(theme)} ${themeStyles.hover.text(theme)} transition-colors`}>
                              <Settings className="w-3.5 h-3.5" />
                              <span>管理技能</span>
                            </button>
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>

                    {/* 插件 */}
                    <Popover open={expandedMenu === 'plugins'} onOpenChange={(open) => setExpandedMenu(open ? 'plugins' : null)}>
                      <PopoverTrigger asChild>
                        <button 
                          className={`w-full flex items-center gap-3 px-4 py-2.5 ${themeStyles.hover.bg(theme)} transition-colors`}
                        >
                          <Puzzle className={`w-5 h-5 ${themeStyles.text.muted(theme)}`} />
                          <span className={`text-sm ${themeStyles.text.secondary(theme)} flex-1 text-left`}>插件</span>
                          <ChevronRightIcon className={`w-4 h-4 ${themeStyles.text.muted(theme)}`} />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent 
                        side="right" 
                        align="start"
                        sideOffset={8}
                        className={`w-72 p-0 ${themeStyles.popover.bg(theme)} ${themeStyles.popover.border(theme)}`}
                      >
                        <div className="py-2">
                          {sortByEnabled(plugins).map((plugin) => (
                            <button 
                              key={plugin.id}
                              onClick={() => togglePlugin(plugin.id)}
                              className={`w-full flex items-center gap-3 px-4 py-2 ${themeStyles.hover.bg(theme)} transition-colors`}
                            >
                              <span className="text-base">{plugin.icon}</span>
                              <span className={`text-sm flex-1 text-left ${plugin.enabled ? themeStyles.text.secondary(theme) : themeStyles.text.disabled(theme)}`}>
                                {plugin.name}
                              </span>
                              <div 
                                className={`w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
                                  plugin.enabled ? 'bg-orange-600' : 'bg-neutral-400'
                                }`}
                              >
                                <div 
                                  className={`w-4 h-4 rounded-full bg-white transition-transform transform ${
                                    plugin.enabled ? 'translate-x-4' : 'translate-x-0.5'
                                  } mt-0.5`}
                                ></div>
                              </div>
                            </button>
                          ))}
                          <div className={`border-t ${themeStyles.border.primary(theme)} mt-2 pt-2`}>
                            <button className={`w-full flex items-center gap-2 px-4 py-2 text-xs ${themeStyles.text.disabled(theme)} ${themeStyles.hover.text(theme)} transition-colors`}>
                              <Settings className="w-3.5 h-3.5" />
                              <span>管理插件</span>
                            </button>
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                </PopoverContent>
              </Popover>

              <div className="flex-1"></div>

              {/* 模型选择器 - 带弹窗 */}
              <Popover open={isModelPopoverOpen} onOpenChange={setIsModelPopoverOpen}>
                <PopoverTrigger asChild>
                  <button className={`flex items-center gap-2 px-4 py-2 ${themeStyles.hover.bgSecondary(theme)} rounded-md transition-colors text-sm ${themeStyles.text.tertiary(theme)}`}>
                    <span>{selectedModel}</span>
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent 
                  side="bottom" 
                  align="end" 
                  className={`w-80 p-0 ${themeStyles.popover.bg(theme)} ${themeStyles.popover.border(theme)}`}
                  sideOffset={8}
                  alignOffset={0}
                  avoidCollisions={false}
                >
                  <div className="py-3">
                    <div className="px-4 pb-3">
                      <h4 className={`text-sm ${themeStyles.text.muted(theme)}`}>选择模型</h4>
                    </div>
                    <div className="px-3 space-y-1">
                      {models.map((model) => (
                        <button
                          key={model.name}
                          onClick={() => {
                            setSelectedModel(model.name);
                            setIsModelPopoverOpen(false);
                          }}
                          className={`w-full px-3 py-2 rounded-md text-left ${themeStyles.hover.bg(theme)} transition-colors flex items-center justify-between ${
                            selectedModel === model.name ? themeStyles.card.bg(theme) : ''
                          }`}
                        >
                          <div>
                            <p className={`text-sm ${themeStyles.text.secondary(theme)}`}>{model.name}</p>
                            <p className={`text-xs ${themeStyles.text.disabled(theme)}`}>{model.provider}</p>
                          </div>
                          {selectedModel === model.name && (
                            <Check className="w-4 h-4 text-green-500 flex-shrink-0" />
                          )}
                        </button>
                      ))}
                    </div>
                    <div className={`px-3 pt-3 border-t ${themeStyles.border.primary(theme)} mt-3`}>
                      <button 
                        onClick={() => {
                          setDeepThinkingEnabled(!deepThinkingEnabled);
                        }}
                        className={`w-full flex items-center justify-between px-3 py-2 text-sm ${themeStyles.hover.bg(theme)} rounded-md transition-colors`}
                      >
                        <span className={themeStyles.text.secondary(theme)}>支持深度思考</span>
                        <div 
                          className={`w-10 h-5 rounded-full transition-colors ${
                            deepThinkingEnabled ? 'bg-orange-600' : 'bg-neutral-400'
                          }`}
                        >
                          <div 
                            className={`w-4 h-4 rounded-full bg-white transition-transform transform ${
                              deepThinkingEnabled ? 'translate-x-5' : 'translate-x-0.5'
                            } mt-0.5`}
                          ></div>
                        </div>
                      </button>
                    </div>
                    <div className={`px-3 pt-3 border-t ${themeStyles.border.primary(theme)} mt-3`}>
                      <button 
                        onClick={() => {
                          setIsModelPopoverOpen(false);
                          setIsModelDialogOpen(true);
                        }}
                        className={`flex items-center gap-2 px-3 py-2 text-sm ${themeStyles.text.muted(theme)} ${themeStyles.hover.text(theme)} transition-colors`}
                      >
                        <Settings className="w-4 h-4" />
                        <span>管理模型供应商</span>
                      </button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>

              {/* 马上开始按钮 - 带思考方式选择 */}
              <Popover open={isThinkingPopoverOpen} onOpenChange={setIsThinkingPopoverOpen}>
                <PopoverTrigger asChild>
                  <button className="flex items-center gap-2 px-5 py-2 bg-orange-600 hover:bg-orange-500 rounded-md transition-colors text-sm text-white">
                    <span>马上开始</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent 
                  side="top" 
                  align="end" 
                  className={`w-64 p-0 ${themeStyles.popover.bg(theme)} ${themeStyles.popover.border(theme)}`}
                  sideOffset={8}
                >
                  <div className="py-3">
                    <div className="px-4 pb-3">
                      <h4 className={`text-sm ${themeStyles.text.muted(theme)}`}>思考方式</h4>
                    </div>
                    <div className="px-3 space-y-1">
                      {thinkingModes.map((mode) => (
                        <button
                          key={mode.name}
                          onClick={() => {
                            setSelectedThinking(mode.name);
                            setIsThinkingPopoverOpen(false);
                          }}
                          className={`w-full px-3 py-2 rounded-md text-left ${themeStyles.hover.bg(theme)} transition-colors ${
                            selectedThinking === mode.name ? themeStyles.card.bg(theme) : ''
                          }`}
                        >
                          <p className={`text-sm ${themeStyles.text.secondary(theme)}`}>{mode.name}</p>
                          <p className={`text-xs ${themeStyles.text.disabled(theme)}`}>{mode.description}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </div>
      </div>

      {/* 模型配置对话框 */}
      <ModelDialog 
        open={isModelDialogOpen} 
        onOpenChange={(open) => { if (!open) setIsModelDialogOpen(false); }} 
      />
    </div>
  );
}
