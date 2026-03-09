import { ChevronDown, Clock, Check, X, Loader2, Square, ChevronRight, ExternalLink, FileText, FileCode, Presentation, RefreshCw, Folder, Package, Wrench, Sparkles, PanelLeftClose, ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { useTheme } from '../contexts/ThemeContext';
import { themeStyles } from '../utils/theme';

interface ChatDetailProps {
  onClose: () => void;
  onCreateTask?: () => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

export function ChatDetail({ onClose, onCreateTask, sidebarCollapsed = false, onToggleSidebar }: ChatDetailProps) {
  const { theme } = useTheme();
  const [isExecuting, setIsExecuting] = useState(true);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const [expandedSections, setExpandedSections] = useState({
    progress: true,
    workspace: true,
    workspaceFiles: true,
    artifacts: true,
    mcp: true,
    skills: true,
    scheduledTasks: true,
    recentTasks: true,
  });
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  const artifacts = [
    { id: '1', name: 'Instructions · CLAUDE.md', type: 'md', icon: FileText, content: 'markdown' },
    { id: '2', name: 'Claude_Cowork_深度调研报告.md', type: 'md', icon: FileText, content: 'markdown' },
    { id: '3', name: 'presentation.html', type: 'html', icon: FileCode, content: 'html' },
  ];

  // Mock MCP服务数据
  const mcpServices = [
    { id: 'mcp-1', name: 'Web Search', emoji: '🔍', description: '网页搜索服务' },
    { id: 'mcp-2', name: 'Claude in Chrome', emoji: '🌐', description: 'Chrome浏览器扩展', hasLink: true },
    { id: 'mcp-3', name: 'File System', emoji: '📁', description: '文件系统访问' },
  ];

  // Mock技能数据
  const skills = [
    { id: 'skill-1', name: 'PDF处理', emoji: '📄', description: 'PDF文件读取和分析' },
    { id: 'skill-2', name: 'PPTX生成', emoji: '📊', description: '演示文稿创建' },
    { id: 'skill-3', name: '图像处理', emoji: '🖼️', description: '图像分析和处理' },
  ];



  // Mock数据：有产物的场景
  const hasArtifacts = artifacts.length > 0;

  const handleArtifactClick = (artifactId: string) => {
    setSelectedArtifact(artifactId);
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className={`flex-1 flex ${themeStyles.bg.primary(theme)}`}>
        {/* 主对话区域 */}
        <div className={`flex-1 flex flex-col ${selectedArtifact ? '' : rightSidebarCollapsed ? 'mr-12' : 'mr-80'}`}>
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
              className={`w-8 h-8 flex items-center justify-center ${themeStyles.hover.bg(theme)} rounded transition-colors opacity-30 cursor-not-allowed`}
              title="后退"
              disabled
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            
            <button
              className={`w-8 h-8 flex items-center justify-center ${themeStyles.hover.bg(theme)} rounded transition-colors opacity-30 cursor-not-allowed`}
              title="前进"
              disabled
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          {/* 中间标题 */}
          <div className="flex-1 flex items-center justify-center">
            <div className="flex items-center gap-2">
              <h2 className={`text-sm ${themeStyles.text.disabled(theme)}`}>Research Claude Cowork features and capabilities</h2>
              <ChevronDown className={`w-4 h-4 ${themeStyles.text.disabled(theme)}`} />
            </div>
          </div>

          {/* 右侧关闭按钮 */}
          <div className="flex items-center gap-1 px-4">
            <button onClick={onClose} className={`w-8 h-8 flex items-center justify-center ${themeStyles.hover.bg(theme)} rounded transition-colors ${themeStyles.text.disabled(theme)} ${themeStyles.hover.text(theme)}`}>
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* 对话内容区域 */}
        <div className="flex-1 overflow-y-auto m-[0px] p-[0px]">
          <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
            {/* 用户消息 */}
            <div className={`${themeStyles.bg.secondary(theme)} rounded-lg p-4`}>
              <p className={themeStyles.text.primary(theme)}>
                我把喝水上厕所都测了，你重新给我加回来，并且喝水提醒改为两个小时一次，必须要在白天
              </p>
            </div>

            {/* AI 思考过程 */}
            <div className="space-y-4">
              <div className={`flex items-center gap-2 ${themeStyles.text.muted(theme)} text-sm`}>
                <span>Thought process</span>
                <ChevronRight className="w-4 h-4" />
              </div>

              <div className={`${themeStyles.card.bg(theme)} border ${themeStyles.card.border(theme)} rounded-lg p-4`}>
                <p className={`${themeStyles.text.primary(theme)} mb-4`}>
                  白天我定为 8:00-20:00，两个一起回来！
                </p>

                {/* 定时任务确认卡片 */}
                <div className={`${themeStyles.bg.secondary(theme)} border ${themeStyles.card.border(theme)} rounded-lg p-4 space-y-4`}>
                  <div className="flex items-start gap-3">
                    <Clock className={`w-5 h-5 ${themeStyles.text.muted(theme)} mt-0.5`} />
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`text-sm font-medium ${themeStyles.text.primary(theme)}`}>Schedule task</span>
                        <span className={`text-sm ${themeStyles.text.muted(theme)}`}>Drink water reminder</span>
                      </div>
                      <p className={`text-sm ${themeStyles.text.muted(theme)} mb-1`}>
                        白天每2小时提醒用户喝水（8:00-20:00）
                      </p>
                      <p className={`text-xs ${themeStyles.text.disabled(theme)}`}>
                        At 08:00 AM, 10:00 AM, 12:00 PM, 02:00 PM, 04:00 PM, 06:00 PM and 08:00 PM, every day
                      </p>

                      <button 
                        onClick={() => setDetailsExpanded(!detailsExpanded)}
                        className={`text-xs ${themeStyles.text.disabled(theme)} ${themeStyles.hover.text(theme)} mt-2 flex items-center gap-1`}
                      >
                        <ChevronRight className={`w-3 h-3 transition-transform ${detailsExpanded ? 'rotate-90' : ''}`} />
                        Details
                      </button>

                      {detailsExpanded && (
                        <div className={`mt-3 p-3 ${themeStyles.bg.tertiary(theme)} rounded text-xs ${themeStyles.text.muted(theme)} space-y-1`}>
                          <p>任务类型: 定时提醒</p>
                          <p>重复频率: 每天</p>
                          <p>时间范围: 08:00 - 20:00</p>
                          <p>间隔时间: 2小时</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 确认按钮 */}
                  <div className="flex items-center gap-3">
                    <button className={`flex items-center gap-2 px-4 py-2 ${themeStyles.bg.tertiary(theme)} ${themeStyles.hover.bgSecondary(theme)} rounded-md text-sm transition-colors`}>
                      <RefreshCw className="w-4 h-4" />
                      <span>Schedule</span>
                    </button>
                    <button className={`px-4 py-2 ${themeStyles.bg.secondary(theme)} ${themeStyles.hover.bgSecondary(theme)} rounded-md text-sm transition-colors`}>
                      Cancel <span className={`${themeStyles.text.disabled(theme)} ml-1`}>Esc</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* 执行状态 */}
            <div className="flex items-center gap-3 py-4">
              {isExecuting ? (
                <>
                  <Loader2 className="w-5 h-5 text-orange-500 animate-spin" />
                  <span className={`text-sm ${themeStyles.text.muted(theme)}`}>Working on it...</span>
                  <button 
                    onClick={() => setIsExecuting(false)}
                    className={`ml-auto px-3 py-1.5 ${themeStyles.bg.secondary(theme)} ${themeStyles.hover.bgSecondary(theme)} rounded-md text-sm transition-colors flex items-center gap-2`}
                  >
                    <Square className="w-3 h-3" />
                    <span>停止执行</span>
                  </button>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <Check className="w-5 h-5 text-green-500" />
                  <span className="text-sm text-green-500">执行完成</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 输入区域 */}
        <div className={`border-t ${themeStyles.border.primary(theme)} p-4`}>
          <input
            type="text"
            placeholder="继续对话..."
            className={`w-full ${themeStyles.bg.secondary(theme)} ${themeStyles.text.primary(theme)} px-4 py-3 rounded-lg outline-none ${themeStyles.input.placeholder(theme)} focus:ring-1 focus:ring-neutral-700`}
          />
        </div>
      </div>

      {/* 右侧栏 */}
      {!selectedArtifact && (
        <div className={`border-l ${themeStyles.border.primary(theme)} ${themeStyles.bg.secondary(theme)} transition-[width] duration-200 ${rightSidebarCollapsed ? 'w-12' : 'w-80'} flex flex-col`}>
          {/* 折叠按钮 */}
          <div className={`h-12 border-b ${themeStyles.border.primary(theme)} flex items-center justify-between px-3`}>
            {!rightSidebarCollapsed && (
              <span className={`text-xs ${themeStyles.text.disabled(theme)}`}>详情</span>
            )}
            <button 
              onClick={() => setRightSidebarCollapsed(!rightSidebarCollapsed)}
              className={`${themeStyles.text.disabled(theme)} ${themeStyles.hover.text(theme)} ml-auto`}
              title={rightSidebarCollapsed ? "展开详情栏" : "折叠详情栏"}
            >
              <PanelLeftClose className={`w-5 h-5 transition-transform ${rightSidebarCollapsed ? 'rotate-180' : ''}`} />
            </button>
          </div>

          {!rightSidebarCollapsed && (
            <div className="flex-1 overflow-y-auto">
              {/* 计划执行进度 */}
              <div className={`border-b ${themeStyles.border.primary(theme)}`}>
                <button
                  onClick={() => toggleSection('progress')}
                  className={`w-full flex items-center justify-between px-4 py-3 ${themeStyles.hover.bg(theme)} transition-colors`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">计划执行进度</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs ${themeStyles.text.disabled(theme)}`}>4 of 4</span>
                    <ChevronDown className={`w-4 h-4 ${themeStyles.text.disabled(theme)} transition-transform ${expandedSections.progress ? '' : '-rotate-90'}`} />
                  </div>
                </button>
                {expandedSections.progress && (
                  <div className="px-4 pb-4 space-y-2">
                    <div className="flex items-center gap-2 text-sm text-green-500">
                      <Check className="w-4 h-4" />
                      <span>分析用户需求</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-green-500">
                      <Check className="w-4 h-4" />
                      <span>创建喝水提醒任务</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-green-500">
                      <Check className="w-4 h-4" />
                      <span>创建如厕提醒任���</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-orange-500">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>等待用户确认</span>
                    </div>
                  </div>
                )}
              </div>

              {/* 工作区 */}
              <div className="border-b border-neutral-800">
                <button
                  onClick={() => toggleSection('workspace')}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-neutral-800 transition-colors"
                >
                  <span className="text-sm font-medium">工作区</span>
                  <ChevronDown className={`w-4 h-4 text-neutral-500 transition-transform ${expandedSections.workspace ? '' : '-rotate-90'}`} />
                </button>
                {expandedSections.workspace && (
                  <div>
                    {/* 输出文件 */}
                    <div className="px-4 pb-2">
                      <button
                        onClick={() => toggleSection('workspaceFiles')}
                        className="w-full flex items-center justify-between py-2 hover:bg-neutral-800 transition-colors rounded px-2 -mx-2"
                      >
                        <div className="flex items-center gap-2">
                          <ChevronDown className={`w-3 h-3 text-neutral-500 transition-transform ${expandedSections.workspaceFiles ? '' : '-rotate-90'}`} />
                          <span className="text-sm text-neutral-400">输出文件</span>
                        </div>
                        <ExternalLink className="w-3 h-3 text-neutral-500" />
                      </button>
                      {expandedSections.workspaceFiles && (
                        <div className="pl-5 pt-2">
                          <div className="flex items-center gap-2 py-2 text-sm text-neutral-500">
                            <Folder className="w-4 h-4" />
                            <span>任务输出文件保存在此处</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* 产物 */}
              <div className="border-b border-neutral-800">
                <button
                  onClick={() => toggleSection('artifacts')}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-neutral-800 transition-colors"
                >
                  <span className="text-sm font-medium">产物</span>
                  <ChevronDown className={`w-4 h-4 text-neutral-500 transition-transform ${expandedSections.artifacts ? '' : '-rotate-90'}`} />
                </button>
                {expandedSections.artifacts && (
                  <div className="px-4 pb-4">
                    {hasArtifacts ? (
                      <div className="space-y-1">
                        {artifacts.map((artifact) => {
                          const Icon = artifact.icon;
                          return (
                            <button
                              key={artifact.id}
                              onClick={() => handleArtifactClick(artifact.id)}
                              className="w-full flex items-center gap-2 px-2 py-2 hover:bg-neutral-800 rounded transition-colors text-left"
                            >
                              <Icon className="w-4 h-4 text-neutral-400" />
                              <span className="text-sm text-neutral-300 flex-1 truncate">{artifact.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 py-2 text-sm text-neutral-500">
                        <Package className="w-4 h-4" />
                        <span>暂无输出产物</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* MCP服务 */}
              <div className="border-b border-neutral-800">
                <button
                  onClick={() => toggleSection('mcp')}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-neutral-800 transition-colors"
                >
                  <span className="text-sm font-medium">MCP服务</span>
                  <ChevronDown className={`w-4 h-4 text-neutral-500 transition-transform ${expandedSections.mcp ? '' : '-rotate-90'}`} />
                </button>
                {expandedSections.mcp && (
                  <div className="px-4 pb-4 space-y-1">
                    {mcpServices.map((service) => (
                      <div
                        key={service.id}
                        className="flex items-center gap-2 px-2 py-2 hover:bg-neutral-800 rounded transition-colors"
                      >
                        <span className="text-base">{service.emoji}</span>
                        <span className="text-sm text-neutral-300 flex-1">{service.name}</span>
                        {service.hasLink && (
                          <ExternalLink className="w-3 h-3 text-neutral-500" />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 技能 */}
              <div className="border-b border-neutral-800">
                <button
                  onClick={() => toggleSection('skills')}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-neutral-800 transition-colors"
                >
                  <span className="text-sm font-medium">技能</span>
                  <ChevronDown className={`w-4 h-4 text-neutral-500 transition-transform ${expandedSections.skills ? '' : '-rotate-90'}`} />
                </button>
                {expandedSections.skills && (
                  <div className="px-4 pb-4 space-y-1">
                    {skills.map((skill) => (
                      <div
                        key={skill.id}
                        className="flex items-center gap-2 px-2 py-2 hover:bg-neutral-800 rounded transition-colors"
                      >
                        <span className="text-base">{skill.emoji}</span>
                        <span className="text-sm text-neutral-300">{skill.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 产物预览区域 */}
      {selectedArtifact && (
        <div className={`flex-1 flex border-l-2 ${themeStyles.border.primary(theme)}`}>
          <div className={`w-1/2 flex flex-col ${themeStyles.bg.primary(theme)}`}>
            {/* 预览顶部栏 */}
            <div className={`h-12 border-b ${themeStyles.border.primary(theme)} flex items-center justify-between px-4 ${themeStyles.bg.primary(theme)}`}>
              <div className="flex items-center gap-3">
                <span className={`text-sm ${themeStyles.text.tertiary(theme)}`}>
                  {artifacts.find(a => a.id === selectedArtifact)?.name}
                </span>
              </div>
              <button 
                onClick={() => setSelectedArtifact(null)}
                className={`${themeStyles.text.disabled(theme)} ${themeStyles.hover.text(theme)}`}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 预览内容 */}
            <div className={`flex-1 overflow-y-auto p-8 ${themeStyles.bg.primary(theme)}`}>
              <div className="max-w-full mx-auto prose prose-neutral">
                <h1 className={`text-3xl font-bold ${themeStyles.text.primary(theme)} mb-4`}>Claude Research Instructions</h1>
                <p className={`${themeStyles.text.tertiary(theme)} mb-4`}>
                  This document contains the instructions and guidelines for conducting research using Claude.
                </p>
                <h2 className={`text-2xl font-semibold ${themeStyles.text.primary(theme)} mt-6 mb-3`}>Overview</h2>
                <p className={themeStyles.text.tertiary(theme)}>
                  Claude is designed to help with various research tasks including literature review, 
                  data analysis, and report generation.
                </p>
              </div>
            </div>
          </div>

          {/* 预览时的右侧栏 */}
          <div className={`w-1/2 border-l-2 ${themeStyles.border.primary(theme)} ${themeStyles.bg.tertiary(theme)} flex flex-col`}>
            <div className={`h-12 border-b ${themeStyles.border.primary(theme)} flex items-center justify-between px-4`}>
              <span className={`text-xs ${themeStyles.text.muted(theme)}`}>详情</span>
              <button 
                onClick={() => setSelectedArtifact(null)}
                className={`${themeStyles.text.disabled(theme)} ${themeStyles.hover.text(theme)}`}
                title="折叠详情栏"
              >
                <PanelLeftClose className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {/* 计划执行进度 */}
              <div className={`border-b ${themeStyles.border.primary(theme)}`}>
                <button
                  onClick={() => toggleSection('progress')}
                  className={`w-full flex items-center justify-between px-4 py-3 ${themeStyles.hover.bg(theme)} transition-colors`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">计划执行进度</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs ${themeStyles.text.disabled(theme)}`}>4 of 4</span>
                    <ChevronDown className={`w-4 h-4 ${themeStyles.text.disabled(theme)} transition-transform ${expandedSections.progress ? '' : '-rotate-90'}`} />
                  </div>
                </button>
                {expandedSections.progress && (
                  <div className="px-4 pb-4 space-y-2">
                    <div className="flex items-center gap-2 text-sm text-green-500">
                      <Check className="w-4 h-4" />
                      <span>分析用户需求</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-green-500">
                      <Check className="w-4 h-4" />
                      <span>创建喝水提醒任务</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-green-500">
                      <Check className="w-4 h-4" />
                      <span>创建如厕提醒任务</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-orange-500">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>等待用户确认</span>
                    </div>
                  </div>
                )}
              </div>

              {/* 工作区 */}
              <div className={`border-b ${themeStyles.border.primary(theme)}`}>
                <button
                  onClick={() => toggleSection('workspace')}
                  className={`w-full flex items-center justify-between px-4 py-3 ${themeStyles.hover.bg(theme)} transition-colors`}
                >
                  <span className="text-sm font-medium">工作区</span>
                  <ChevronDown className={`w-4 h-4 ${themeStyles.text.disabled(theme)} transition-transform ${expandedSections.workspace ? '' : '-rotate-90'}`} />
                </button>
                {expandedSections.workspace && (
                  <div>
                    {/* 输出文件 */}
                    <div className="px-4 pb-2">
                      <button
                        onClick={() => toggleSection('workspaceFiles')}
                        className={`w-full flex items-center justify-between py-2 ${themeStyles.hover.bg(theme)} transition-colors rounded px-2 -mx-2`}
                      >
                        <div className="flex items-center gap-2">
                          <ChevronDown className={`w-3 h-3 ${themeStyles.text.disabled(theme)} transition-transform ${expandedSections.workspaceFiles ? '' : '-rotate-90'}`} />
                          <span className={`text-sm ${themeStyles.text.muted(theme)}`}>输出文件</span>
                        </div>
                        <ExternalLink className={`w-3 h-3 ${themeStyles.text.disabled(theme)}`} />
                      </button>
                      {expandedSections.workspaceFiles && (
                        <div className="pl-5 pt-2">
                          <div className={`flex items-center gap-2 py-2 text-sm ${themeStyles.text.disabled(theme)}`}>
                            <Folder className="w-4 h-4" />
                            <span>任务输出文件保存在此处</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* 产物 */}
              <div className={`border-b ${themeStyles.border.primary(theme)}`}>
                <button
                  onClick={() => toggleSection('artifacts')}
                  className={`w-full flex items-center justify-between px-4 py-3 ${themeStyles.hover.bg(theme)} transition-colors`}
                >
                  <span className="text-sm font-medium">产物</span>
                  <ChevronDown className={`w-4 h-4 ${themeStyles.text.disabled(theme)} transition-transform ${expandedSections.artifacts ? '' : '-rotate-90'}`} />
                </button>
                {expandedSections.artifacts && (
                  <div className="px-4 pb-4">
                    {hasArtifacts ? (
                      <div className="space-y-1">
                        {artifacts.map((artifact) => {
                          const Icon = artifact.icon;
                          const isActive = artifact.id === selectedArtifact;
                          return (
                            <button
                              key={artifact.id}
                              onClick={() => handleArtifactClick(artifact.id)}
                              className={`w-full flex items-center gap-2 px-2 py-2 ${themeStyles.hover.bg(theme)} rounded transition-colors text-left ${
                                isActive ? themeStyles.bg.tertiary(theme) : ''
                              }`}
                            >
                              <Icon className={`w-4 h-4 ${themeStyles.text.muted(theme)}`} />
                              <span className={`text-sm ${themeStyles.text.primary(theme)} flex-1 truncate`}>{artifact.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className={`flex items-center gap-2 py-2 text-sm ${themeStyles.text.disabled(theme)}`}>
                        <Package className="w-4 h-4" />
                        <span>暂无输出产物</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* MCP服务 */}
              <div className={`border-b ${themeStyles.border.primary(theme)}`}>
                <button
                  onClick={() => toggleSection('mcp')}
                  className={`w-full flex items-center justify-between px-4 py-3 ${themeStyles.hover.bg(theme)} transition-colors`}
                >
                  <span className="text-sm font-medium">MCP服务</span>
                  <ChevronDown className={`w-4 h-4 ${themeStyles.text.disabled(theme)} transition-transform ${expandedSections.mcp ? '' : '-rotate-90'}`} />
                </button>
                {expandedSections.mcp && (
                  <div className="px-4 pb-4 space-y-1">
                    {mcpServices.map((service) => (
                      <div
                        key={service.id}
                        className={`flex items-center gap-2 px-2 py-2 ${themeStyles.hover.bg(theme)} rounded transition-colors`}
                      >
                        <span className="text-base">{service.emoji}</span>
                        <span className={`text-sm ${themeStyles.text.primary(theme)} flex-1`}>{service.name}</span>
                        {service.hasLink && (
                          <ExternalLink className={`w-3 h-3 ${themeStyles.text.disabled(theme)}`} />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 技能 */}
              <div className={`border-b ${themeStyles.border.primary(theme)}`}>
                <button
                  onClick={() => toggleSection('skills')}
                  className={`w-full flex items-center justify-between px-4 py-3 ${themeStyles.hover.bg(theme)} transition-colors`}
                >
                  <span className="text-sm font-medium">技能</span>
                  <ChevronDown className={`w-4 h-4 ${themeStyles.text.disabled(theme)} transition-transform ${expandedSections.skills ? '' : '-rotate-90'}`} />
                </button>
                {expandedSections.skills && (
                  <div className="px-4 pb-4 space-y-1">
                    {skills.map((skill) => (
                      <div
                        key={skill.id}
                        className={`flex items-center gap-2 px-2 py-2 ${themeStyles.hover.bg(theme)} rounded transition-colors`}
                      >
                        <span className="text-base">{skill.emoji}</span>
                        <span className={`text-sm ${themeStyles.text.primary(theme)}`}>{skill.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
    </TooltipProvider>
  );
}
