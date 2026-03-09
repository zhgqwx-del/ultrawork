import { Plus, Search, Clock, Briefcase, Settings as SettingsIcon, Circle, MoreVertical, Star, Edit2, Trash2, Check, Loader2, PanelLeftClose, Sparkles } from 'lucide-react';
import { SettingsPopover } from './SettingsPopover';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';
import { useTheme } from '../contexts/ThemeContext';
import { themeStyles } from '../utils/theme';

interface SidebarProps {
  onOpenSettings: () => void;
  onOpenChat?: (chatId: string) => void;
  onCreateTask?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function Sidebar({ onOpenSettings, onOpenChat, onCreateTask, collapsed = false, onToggleCollapse }: SidebarProps) {
  const { theme } = useTheme();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null);

  // Mock定时任务数据（只显示生效的）
  const scheduledTasks = [
    { id: 'schedule-1', name: '喝水提醒', time: '每2小时', enabled: true },
    { id: 'schedule-2', name: '如厕提醒', time: '每3小时', enabled: true },
    { id: 'schedule-3', name: '站立休息', time: '每1小时', enabled: true },
  ];

  // Mock最近任务数据（15条）
  const [recentTasks, setRecentTasks] = useState([
    { id: 'task-1', name: 'Research Claude Cowork features', status: 'running' },
    { id: 'task-2', name: '美伊冲突对东南亚股市的影响分析', status: 'completed' },
    { id: 'task-3', name: '设置喝水提醒任务', status: 'completed' },
    { id: 'task-4', name: '生成项目文档', status: 'running' },
    { id: 'task-5', name: '数据分析报告', status: 'completed' },
    { id: 'task-6', name: '代码审查和优化建议', status: 'completed' },
    { id: 'task-7', name: '翻译技术文档', status: 'completed' },
    { id: 'task-8', name: '创建演示文稿', status: 'completed' },
    { id: 'task-9', name: '竞品分析报告', status: 'completed' },
    { id: 'task-10', name: 'API文档整理', status: 'completed' },
    { id: 'task-11', name: '用户调研总结', status: 'completed' },
    { id: 'task-12', name: '性能优化建议', status: 'completed' },
    { id: 'task-13', name: '数据库设计方案', status: 'completed' },
    { id: 'task-14', name: '测试用例编写', status: 'completed' },
    { id: 'task-15', name: '产品需求分析', status: 'completed' },
  ]);

  const handleStartRename = (taskId: string, currentName: string) => {
    setEditingTaskId(taskId);
    setEditingValue(currentName);
  };

  const handleFinishRename = (taskId: string) => {
    if (editingValue.trim()) {
      setRecentTasks(tasks => 
        tasks.map(t => t.id === taskId ? { ...t, name: editingValue.trim() } : t)
      );
    }
    setEditingTaskId(null);
    setEditingValue('');
  };

  const handleCancelRename = () => {
    setEditingTaskId(null);
    setEditingValue('');
  };

  const handleDeleteTask = (taskId: string) => {
    setRecentTasks(tasks => tasks.filter(t => t.id !== taskId));
    setDeleteTaskId(null);
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className={`${themeStyles.bg.sidebar(theme)} border-r ${themeStyles.border.primary(theme)} flex flex-col ${collapsed ? 'w-12' : 'w-52'}`}>
        {/* 顶部区域 */}
        <div className="flex flex-col">
          {/* 产品图标和折叠按钮 */}
          <div className={`h-12 border-b ${themeStyles.border.primary(theme)} flex items-center justify-between px-3`}>
            {!collapsed && (
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 bg-gradient-to-br from-purple-500 to-blue-500 rounded flex items-center justify-center">
                  <Sparkles className="w-4 h-4 text-white" />
                </div>
                <span className="text-sm font-medium">无影 UltraWork</span>
              </div>
            )}
            {collapsed && onToggleCollapse && (
              <button
                onClick={onToggleCollapse}
                className="w-6 h-6 bg-gradient-to-br from-purple-500 to-blue-500 rounded flex items-center justify-center mx-auto cursor-pointer hover:opacity-80 transition-opacity"
                title="展开侧边栏"
              >
                <Sparkles className="w-4 h-4 text-white" />
              </button>
            )}
          </div>

          {/* 折叠状态下只显示图标按钮 */}
          {collapsed ? (
            <div className="flex flex-col items-center py-2 space-y-2">
              <button onClick={onCreateTask} className={`w-8 h-8 flex items-center justify-center ${themeStyles.hover.bg(theme)} rounded transition-colors`} title="新建任务">
                <Plus className="w-4 h-4" />
              </button>
              <button className={`w-8 h-8 flex items-center justify-center ${themeStyles.hover.bg(theme)} rounded transition-colors`} title="搜索">
                <Search className="w-4 h-4" />
              </button>
              <button className={`w-8 h-8 flex items-center justify-center ${themeStyles.hover.bg(theme)} rounded transition-colors`} title="定时任务">
                <Clock className="w-4 h-4" />
              </button>
              <button className={`w-8 h-8 flex items-center justify-center ${themeStyles.hover.bg(theme)} rounded transition-colors`} title="自定义">
                <Briefcase className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <>
              {/* 新建任务按钮 */}
              <button onClick={onCreateTask} className={`flex items-center gap-2 px-4 py-3 ${themeStyles.hover.bg(theme)} transition-colors`}>
                <Plus className="w-4 h-4" />
                <span className="text-sm">新建任务</span>
              </button>

              {/* 搜索 */}
              <button className={`flex items-center gap-2 px-4 py-3 ${themeStyles.hover.bg(theme)} transition-colors`}>
                <Search className="w-4 h-4" />
                <span className="text-sm">搜索</span>
              </button>

              {/* 定时任务 */}
              <button className={`flex items-center gap-2 px-4 py-3 ${themeStyles.hover.bg(theme)} transition-colors`}>
                <Clock className="w-4 h-4" />
                <span className="text-sm">定时任务</span>
              </button>

              {/* 自定义 */}
              <button className={`flex items-center gap-2 px-4 py-3 ${themeStyles.hover.bg(theme)} transition-colors`}>
                <Briefcase className="w-4 h-4" />
                <span className="text-sm">自定义</span>
              </button>
            </>
          )}
        </div>

        {/* 任务列表区域 - 只在非折叠状态显示 */}
        {!collapsed && (
          <div className="flex-1 overflow-y-auto">
            {/* 定时任务列表 */}
            <div className="mt-4 px-4">
              <h3 className={`text-xs ${themeStyles.text.muted(theme)} mb-3`}>定时任务</h3>
              <div className="space-y-1 max-h-[300px] overflow-y-auto overflow-x-hidden scrollbar-thin">
                {scheduledTasks.filter(task => task.enabled).map((task) => (
                  <Tooltip key={task.id}>
                    <TooltipTrigger asChild>
                      <div className={`flex items-center gap-2 py-2 ${themeStyles.hover.bg(theme)} cursor-pointer rounded px-2 -mx-2`}>
                        <Circle className="w-2 h-2 fill-green-500 text-green-500 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm ${themeStyles.text.secondary(theme)} truncate`}>{task.name}</p>
                          <p className="text-xs text-neutral-500">{task.time}</p>
                        </div>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="right" className={`${themeStyles.popover.bg(theme)} ${themeStyles.popover.border(theme)}`}>
                      <p>{task.name}</p>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>

            {/* 最近任务 */}
            <div className="mt-6 px-4 flex-1 overflow-y-auto">
              <h3 className={`text-xs ${themeStyles.text.muted(theme)} mb-3`}>最近任务</h3>
              <div className="space-y-1 max-h-[400px] overflow-y-auto overflow-x-hidden scrollbar-thin">
                {recentTasks.map((task) => (
                  <div
                    key={task.id}
                    className={`group flex items-center gap-2 py-2 ${themeStyles.hover.bg(theme)} rounded px-2 -mx-2 relative`}
                  >
                    {/* 状态图标 */}
                    {task.status === 'running' && (
                      <Loader2 className="w-3 h-3 text-orange-500 animate-spin flex-shrink-0" />
                    )}
                    {task.status === 'completed' && (
                      <Check className="w-3 h-3 text-green-500 flex-shrink-0" />
                    )}

                    {/* 任务名称 - 支持编辑和 Tooltip */}
                    {editingTaskId === task.id ? (
                      <input
                        type="text"
                        value={editingValue}
                        onChange={(e) => setEditingValue(e.target.value)}
                        onBlur={() => handleFinishRename(task.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handleFinishRename(task.id);
                          } else if (e.key === 'Escape') {
                            handleCancelRename();
                          }
                        }}
                        autoFocus
                        className={`flex-1 text-sm ${themeStyles.input.text(theme)} ${themeStyles.input.bg(theme)} border ${themeStyles.input.border(theme)} rounded px-2 py-1 focus:outline-none`}
                      />
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => onOpenChat?.(task.id)}
                            className={`flex-1 text-left text-sm ${themeStyles.text.tertiary(theme)} truncate min-w-0`}
                          >
                            {task.name}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right" className={`${themeStyles.popover.bg(theme)} ${themeStyles.popover.border(theme)} max-w-xs`}>
                          <p>{task.name}</p>
                        </TooltipContent>
                      </Tooltip>
                    )}

                    {/* 三个点菜单 - 最右侧 */}
                    <Popover>
                      <PopoverTrigger asChild>
                        <button 
                          className={`${themeStyles.hover.bgSecondary(theme)} p-0.5 rounded transition-colors flex-shrink-0`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical className={`w-3 h-3 ${themeStyles.text.muted(theme)}`} />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent 
                        className={`w-40 p-1 ${themeStyles.popover.bg(theme)} ${themeStyles.popover.border(theme)}`}
                        align="end"
                        side="right"
                      >
                        <button className={`w-full flex items-center gap-2 px-3 py-2 text-sm ${themeStyles.text.tertiary(theme)} ${themeStyles.hover.bg(theme)} rounded transition-colors`}>
                          <Star className="w-3 h-3" />
                          <span>收藏</span>
                        </button>
                        <button 
                          onClick={() => handleStartRename(task.id, task.name)}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm ${themeStyles.text.tertiary(theme)} ${themeStyles.hover.bg(theme)} rounded transition-colors`}
                        >
                          <Edit2 className="w-3 h-3" />
                          <span>重命名</span>
                        </button>
                        <button 
                          onClick={() => setDeleteTaskId(task.id)}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm ${themeStyles.text.tertiary(theme)} ${themeStyles.hover.bg(theme)} rounded transition-colors`}
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>删除</span>
                        </button>
                      </PopoverContent>
                    </Popover>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 底部区域 */}
        {!collapsed && (
          <SettingsPopover 
            open={isSettingsOpen} 
            onOpenChange={setIsSettingsOpen}
            onOpenFullSettings={onOpenSettings}
          >
            <button 
              className={`border-t ${themeStyles.border.primary(theme)} px-4 py-3 flex items-center gap-2 ${themeStyles.hover.bg(theme)} transition-colors w-full`}
              onClick={() => setIsSettingsOpen(true)}
            >
              <div className={`w-6 h-6 ${theme === 'dark' ? 'bg-neutral-700' : 'bg-neutral-300'} rounded flex items-center justify-center text-xs ${theme === 'dark' ? 'text-white' : 'text-neutral-700'}`}>
                Y
              </div>
              <span className="text-sm flex-1 text-left">映卿的助手</span>
              <SettingsIcon className="w-4 h-4" />
            </button>
          </SettingsPopover>
        )}

        {/* 折叠状态下的用户图标 */}
        {collapsed && (
          <div className={`border-t ${themeStyles.border.primary(theme)} p-2 flex items-center justify-center`}>
            <SettingsPopover 
              open={isSettingsOpen} 
              onOpenChange={setIsSettingsOpen}
              onOpenFullSettings={onOpenSettings}
            >
              <button 
                className={`w-8 h-8 ${themeStyles.hover.bg(theme)} rounded flex items-center justify-center transition-colors`}
                onClick={() => setIsSettingsOpen(true)}
                title="设置"
              >
                <SettingsIcon className="w-4 h-4" />
              </button>
            </SettingsPopover>
          </div>
        )}
      </div>

      {/* 删除确认对话框 */}
      <AlertDialog open={!!deleteTaskId} onOpenChange={(open) => !open && setDeleteTaskId(null)}>
        <AlertDialogContent className={`${theme === 'dark' ? 'bg-neutral-900' : 'bg-white'} ${theme === 'dark' ? 'border-neutral-700' : 'border-neutral-300'}`}>
          <AlertDialogHeader>
            <AlertDialogTitle className={theme === 'dark' ? 'text-neutral-100' : 'text-neutral-900'}>确认删除</AlertDialogTitle>
            <AlertDialogDescription className={theme === 'dark' ? 'text-neutral-400' : 'text-neutral-600'}>
              您确定要删除这个任务吗？此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={`${theme === 'dark' ? 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700 border-neutral-700' : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200 border-neutral-300'}`}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => deleteTaskId && handleDeleteTask(deleteTaskId)}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
