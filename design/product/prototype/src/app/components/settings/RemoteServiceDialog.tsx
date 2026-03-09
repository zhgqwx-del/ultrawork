import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { Plug, Plus, CheckCircle, XCircle } from 'lucide-react';
import { useState } from 'react';

interface RemoteServiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RemoteServiceDialog({ open, onOpenChange }: RemoteServiceDialogProps) {
  const [services, setServices] = useState([
    {
      id: 1,
      name: 'GitHub',
      url: 'https://api.github.com',
      status: 'connected',
      lastSync: '2026-03-05 10:30',
    },
    {
      id: 2,
      name: 'GitLab',
      url: 'https://gitlab.com/api/v4',
      status: 'disconnected',
      lastSync: null,
    },
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-neutral-900 border-neutral-700 text-white max-w-2xl">
        <DialogHeader>
          <DialogTitle>远程服务连接</DialogTitle>
          <DialogDescription className="sr-only">管理远程服务连接状态</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-4">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-neutral-400">管理与外部服务的连接</p>
            <button className="flex items-center gap-2 px-3 py-1.5 bg-orange-600 hover:bg-orange-500 rounded-md text-sm transition-colors">
              <Plus className="w-4 h-4" />
              <span>添加服务</span>
            </button>
          </div>

          <div className="space-y-3">
            {services.map((service) => (
              <div
                key={service.id}
                className="flex items-center justify-between p-4 bg-neutral-800 rounded-lg"
              >
                <div className="flex items-center gap-3 flex-1">
                  <Plug className="w-5 h-5 text-neutral-400" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-sm font-medium">{service.name}</p>
                      {service.status === 'connected' ? (
                        <CheckCircle className="w-4 h-4 text-green-500" />
                      ) : (
                        <XCircle className="w-4 h-4 text-neutral-500" />
                      )}
                    </div>
                    <p className="text-xs text-neutral-500">{service.url}</p>
                    {service.lastSync && (
                      <p className="text-xs text-neutral-600 mt-0.5">
                        最后同步: {service.lastSync}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {service.status === 'connected' ? (
                    <>
                      <button className="px-3 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-xs transition-colors">
                        测试连接
                      </button>
                      <button className="px-3 py-1.5 bg-red-600/20 text-red-500 hover:bg-red-600/30 rounded text-xs transition-colors">
                        断开
                      </button>
                    </>
                  ) : (
                    <button className="px-3 py-1.5 bg-green-600 hover:bg-green-500 rounded text-xs transition-colors">
                      连接
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 p-4 bg-neutral-800/50 border border-neutral-700 rounded-lg">
            <h4 className="text-sm font-medium mb-2">支持的服务类型</h4>
            <div className="grid grid-cols-2 gap-2 text-xs text-neutral-400">
              <div>• Git 仓库（GitHub, GitLab, Gitee）</div>
              <div>• 项目管理（Jira, Trello）</div>
              <div>• 云存储（OSS, S3）</div>
              <div>• 数据库服务</div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
