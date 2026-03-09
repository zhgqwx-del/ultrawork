import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { Folder, Edit, Trash2, Plus } from 'lucide-react';
import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

interface WorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WorkspaceDialog({ open, onOpenChange }: WorkspaceDialogProps) {
  const [workspaces, setWorkspaces] = useState([
    { id: 1, name: '晚的的工作目录', path: '/Users/wp/w/default_workspace', type: 'local' },
    { id: 2, name: '项目A', path: '/Users/wp/projects/project-a', type: 'local' },
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-neutral-900 border-neutral-700 text-white max-w-2xl">
        <DialogHeader>
          <DialogTitle>工作目录配置</DialogTitle>
          <DialogDescription className="sr-only">管理和配置工作目录</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="list" className="mt-4">
          <TabsList className="bg-neutral-800">
            <TabsTrigger value="list">目录列表</TabsTrigger>
            <TabsTrigger value="environment">环境配置</TabsTrigger>
          </TabsList>

          <TabsContent value="list" className="space-y-3 mt-4">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-neutral-400">管理您的工作目录</p>
              <button className="flex items-center gap-2 px-3 py-1.5 bg-orange-600 hover:bg-orange-500 rounded-md text-sm transition-colors">
                <Plus className="w-4 h-4" />
                <span>添加目录</span>
              </button>
            </div>

            <div className="space-y-2">
              {workspaces.map((workspace) => (
                <div
                  key={workspace.id}
                  className="flex items-center justify-between p-3 bg-neutral-800 rounded-lg hover:bg-neutral-750 transition-colors"
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <Folder className="w-5 h-5 text-neutral-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{workspace.name}</p>
                      <p className="text-xs text-neutral-500 truncate">{workspace.path}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button className="p-1.5 hover:bg-neutral-700 rounded transition-colors">
                      <Edit className="w-4 h-4 text-neutral-400" />
                    </button>
                    <button className="p-1.5 hover:bg-neutral-700 rounded transition-colors">
                      <Trash2 className="w-4 h-4 text-neutral-400" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="environment" className="space-y-4 mt-4">
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium mb-2 block">运行环境</label>
                <div className="space-y-2">
                  <button className="w-full flex items-center justify-between p-3 bg-neutral-800 hover:bg-neutral-750 rounded-lg transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-orange-600/20 rounded flex items-center justify-center">
                        <span className="text-orange-500 text-xs">沙</span>
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-medium">沙盒环境</p>
                        <p className="text-xs text-neutral-400">安全的隔离环境，推荐使用</p>
                      </div>
                    </div>
                    <div className="w-4 h-4 rounded-full border-2 border-orange-500 flex items-center justify-center">
                      <div className="w-2 h-2 rounded-full bg-orange-500"></div>
                    </div>
                  </button>

                  <button className="w-full flex items-center justify-between p-3 bg-neutral-800 hover:bg-neutral-750 rounded-lg transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-blue-600/20 rounded flex items-center justify-center">
                        <span className="text-blue-500 text-xs">本</span>
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-medium">本机环境</p>
                        <p className="text-xs text-neutral-400">直接访问本地文件系统</p>
                      </div>
                    </div>
                    <div className="w-4 h-4 rounded-full border-2 border-neutral-600"></div>
                  </button>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
