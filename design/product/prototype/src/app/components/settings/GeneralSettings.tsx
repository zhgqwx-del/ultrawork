import { useState } from 'react';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { useTheme } from '../../contexts/ThemeContext';

export function GeneralSettings() {
  const { theme: currentTheme, setTheme } = useTheme();
  const [autoStart, setAutoStart] = useState(false);
  const [backgroundRun, setBackgroundRun] = useState(true);
  const [desktopNotifications, setDesktopNotifications] = useState(true);
  const [soundNotifications, setSoundNotifications] = useState(false);
  const [workType, setWorkType] = useState('');
  const [chatFont, setChatFont] = useState('default');

  const handleThemeChange = (value: string) => {
    if (value === 'dark' || value === 'light') {
      setTheme(value);
    }
    // TODO: 处理 'system' 选项
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl mb-6">个人资料</h2>
        
        {/* 全称 */}
        <div className="mb-6">
          <Label htmlFor="fullname" className="text-sm text-neutral-400 mb-2 block">
            全称
          </Label>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-neutral-700 rounded flex items-center justify-center text-lg">
              Y
            </div>
            <input
              id="fullname"
              type="text"
              defaultValue="yoyoba"
              className="flex-1 bg-neutral-800 border border-neutral-700 rounded-md px-4 py-2 text-sm text-white focus:outline-none focus:border-neutral-600"
            />
          </div>
        </div>

        {/* 昵称 */}
        <div className="mb-6">
          <Label htmlFor="nickname" className="text-sm text-neutral-400 mb-2 block">
            昵称
          </Label>
          <input
            id="nickname"
            type="text"
            defaultValue="yoyoba"
            className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-4 py-2 text-sm text-white focus:outline-none focus:border-neutral-600"
          />
        </div>

        {/* 工作场景 */}
        <div className="mb-6">
          <Label htmlFor="work" className="text-sm text-neutral-400 mb-2 block">
            工作场景
          </Label>
          <Select value={workType} onValueChange={setWorkType}>
            <SelectTrigger className="w-full bg-neutral-800 border-neutral-700 text-white">
              <SelectValue placeholder="选择您的工作类型" />
            </SelectTrigger>
            <SelectContent side="bottom" className="bg-neutral-800 border-neutral-700 text-white">
              <SelectItem value="developer">开发者</SelectItem>
              <SelectItem value="designer">设计师</SelectItem>
              <SelectItem value="pm">产品经理</SelectItem>
              <SelectItem value="researcher">研究人员</SelectItem>
              <SelectItem value="other">其他</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* 回复偏好 */}
        <div className="mb-6">
          <Label htmlFor="preferences" className="text-sm text-neutral-400 mb-2 block">
            回复偏好
          </Label>
          <p className="text-xs text-neutral-500 mb-2">
            您的偏好将适用于所有对话
          </p>
          <textarea
            id="preferences"
            placeholder="例如：我主要使用 Python 编程（不是编程初学者）"
            rows={4}
            className="w-full bg-neutral-800 border border-neutral-700 rounded-md px-4 py-2 text-sm text-white focus:outline-none focus:border-neutral-600 placeholder:text-neutral-600"
          />
          <p className="text-xs text-neutral-500 mt-2">
            例如：在给出详细回答前先提出澄清性问题，回复风格、语气等
          </p>
        </div>
      </div>

      <div>
        <h2 className="text-2xl mb-6">通知设置</h2>
        
        {/* 开机自启动 */}
        <div className="flex items-start justify-between mb-6 pb-6 border-b border-neutral-800">
          <div className="flex-1">
            <Label className="text-sm text-neutral-200 block mb-1">
              开机自启动
            </Label>
          </div>
          <Switch checked={autoStart} onCheckedChange={setAutoStart} />
        </div>

        {/* 后台运行控制 */}
        <div className="flex items-start justify-between mb-6 pb-6 border-b border-neutral-800">
          <div className="flex-1">
            <Label className="text-sm text-neutral-200 block mb-1">
              后台运行控制
            </Label>
          </div>
          <Switch checked={backgroundRun} onCheckedChange={setBackgroundRun} />
        </div>

        {/* 桌面通知 */}
        <div className="flex items-start justify-between mb-6 pb-6 border-b border-neutral-800">
          <div className="flex-1">
            <Label className="text-sm text-neutral-200 block mb-1">
              桌面通知
            </Label>
            <p className="text-xs text-neutral-500 mt-1">
              当完成回复时接收通知。对工具调用和研究等长时间运行的任务尤为有用。
            </p>
          </div>
          <Switch checked={desktopNotifications} onCheckedChange={setDesktopNotifications} />
        </div>

        {/* 声音通知 */}
        <div className="flex items-start justify-between mb-6 pb-6 border-b border-neutral-800">
          <div className="flex-1">
            <Label className="text-sm text-neutral-200 block mb-1">
              声音通知
            </Label>
          </div>
          <Switch checked={soundNotifications} onCheckedChange={setSoundNotifications} />
        </div>

        {/* 主题风格 */}
        <div className="mb-6">
          <Label className="text-sm text-neutral-400 mb-2 block">
            主题风格
          </Label>
          <Select value={currentTheme} onValueChange={handleThemeChange}>
            <SelectTrigger className="w-full bg-neutral-800 border-neutral-700 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="bottom" className="bg-neutral-800 border-neutral-700 text-white">
              <SelectItem value="dark">深色</SelectItem>
              <SelectItem value="light">浅色</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Chat字体 */}
        <div className="mb-6">
          <Label className="text-sm text-neutral-400 mb-2 block">
            Chat字体
          </Label>
          <Select value={chatFont} onValueChange={setChatFont}>
            <SelectTrigger className="w-full bg-neutral-800 border-neutral-700 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="bottom" className="bg-neutral-800 border-neutral-700 text-white">
              <SelectItem value="default">系统默认</SelectItem>
              <SelectItem value="monospace">等宽字体</SelectItem>
              <SelectItem value="serif">衬线字体</SelectItem>
              <SelectItem value="sans-serif">无衬线字体</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
