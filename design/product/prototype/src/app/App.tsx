import { useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { MainContent } from './components/MainContent';
import { Settings } from './components/Settings';
import { ChatDetail } from './components/ChatDetail';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';

function AppContent() {
  const { theme } = useTheme();
  const [currentView, setCurrentView] = useState<'main' | 'settings'>('main');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(['main']);
  const [historyIndex, setHistoryIndex] = useState(0);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  const goBack = () => {
    if (canGoBack) {
      setHistoryIndex(historyIndex - 1);
      setCurrentView(history[historyIndex - 1] as 'main' | 'settings');
    }
  };

  const goForward = () => {
    if (canGoForward) {
      setHistoryIndex(historyIndex + 1);
      setCurrentView(history[historyIndex + 1] as 'main' | 'settings');
    }
  };

  const navigateTo = (view: 'main' | 'settings') => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(view);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    setCurrentView(view);
  };

  const handleOpenChat = (chatId: string) => {
    setSelectedChatId(chatId);
  };

  const handleCloseChat = () => {
    setSelectedChatId(null);
  };

  const handleCreateTask = () => {
    // 回到初始化页面
    setSelectedChatId(null);
    navigateTo('main');
  };

  return (
    <div className={`flex h-screen ${theme === 'dark' ? 'bg-neutral-900 text-white' : 'bg-white text-neutral-900'}`}>
      <Sidebar 
        onOpenSettings={() => navigateTo('settings')} 
        onOpenChat={handleOpenChat}
        onCreateTask={handleCreateTask}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      {selectedChatId ? (
        <ChatDetail 
          onClose={handleCloseChat} 
          onCreateTask={handleCreateTask}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
      ) : currentView === 'main' ? (
        <MainContent 
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
          onGoBack={goBack}
          onGoForward={goForward}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
        />
      ) : (
        <Settings 
          onBack={() => navigateTo('main')}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
          onGoBack={goBack}
          onGoForward={goForward}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
}
