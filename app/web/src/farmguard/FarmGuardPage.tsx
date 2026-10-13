import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import FarmGuardApp from './FarmGuardApp';
import { farmguardCall } from './api';

export default function FarmGuardPage() {
  const navigate = useNavigate();
  const [preparing, setPreparing] = useState(false);
  const openAssistant = async (caseId?: string) => {
    if (preparing) return;
    if (!caseId) {
      navigate('/chat');
      return;
    }
    setPreparing(true);
    try {
      const prepared = await farmguardCall<{
        jid: string;
        folder: string;
        prompt: string;
      }>('prepareAgentReview', { caseId });
      const { useChatStore } = await import('../stores/chat');
      useChatStore.getState().saveDraft(prepared.jid, prepared.prompt);
      navigate('/chat/' + encodeURIComponent(prepared.folder));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '复核会话准备失败');
    } finally {
      setPreparing(false);
    }
  };
  return (
    <FarmGuardApp
      onOpenAssistant={(caseId) => {
        void openAssistant(caseId);
      }}
    />
  );
}
