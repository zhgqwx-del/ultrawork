import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { MessageSquare, Plus, ExternalLink } from 'lucide-react';

interface ChannelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChannelsDialog({ open, onOpenChange }: ChannelsDialogProps) {
  const channels = [
    {
      id: 'dingtalk',
      name: '钉钉',
      icon: '💬',
      description: '接收钉钉消息通知',
      configured: false,
    },
    {
      id: 'feishu',
      name: '飞书',
      icon: '🕊️',
      description: '接收飞书消息通知',
      configured: true,
    },
    {
      id: 'wechat',
      name: '企业微信',
      icon: '💼',
      description: '接收企业微信消息通知',
      configured: false,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-neutral-900 border-neutral-700 text-white max-w-2xl">
        <DialogHeader>
          <DialogTitle>消息通道配置</DialogTitle>
          <DialogDescription className="sr-only">配置消息通知渠道</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-4">
          <p className="text-sm text-neutral-400 mb-4">
            配置消息通道以接收任务提醒和系统通知
          </p>

          {channels.map((channel) => (
            <div
              key={channel.id}
              className="flex items-center justify-between p-4 bg-neutral-800 rounded-lg hover:bg-neutral-750 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-neutral-700 rounded-lg flex items-center justify-center text-xl">
                  {channel.icon}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{channel.name}</p>
                    {channel.configured && (
                      <span className="px-2 py-0.5 bg-green-600/20 text-green-500 text-xs rounded">
                        已配置
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-neutral-500">{channel.description}</p>
                </div>
              </div>
              <button className="flex items-center gap-2 px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded-md text-sm transition-colors">
                {channel.configured ? '重新配置' : '配置'}
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}

          <div className="mt-6 p-4 bg-neutral-800/50 border border-neutral-700 rounded-lg">
            <div className="flex items-start gap-3">
              <MessageSquare className="w-5 h-5 text-neutral-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-neutral-400">
                <p className="font-medium text-neutral-300 mb-1">配置说明</p>
                <p>点击配置按钮，按照向导完成Webhook URL和访问令牌的设置。配置完成后，系统将通过对应的消息通道发送通知。</p>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
