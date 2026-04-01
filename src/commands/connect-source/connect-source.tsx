import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useState, useEffect } from 'react';
import { Box, Text } from '../../ink.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { Dialog } from '../../components/design-system/Dialog.js';
import TextInput from '../../components/TextInput.js';
import { getGlobalConfig, saveGlobalConfig, activateApiSource, type ApiSource } from '../../utils/config.js';
import { randomUUID } from 'crypto';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';

type Step = 'menu' | 'add-name' | 'add-url' | 'add-key' | 'confirm-add' | 'delete-select' | 'confirm-delete' | 'use-select' | 'confirm-use';

export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  return <ConnectSource onDone={onDone} />;
}

function ConnectSource(props: { onDone: LocalJSXCommandOnDone }) {
  const [step, setStep] = useState<Step>('menu');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<ApiSource[]>([]);
  
  // TextInput state
  const [inputValue, setInputValue] = useState('');
  const [cursorOffset, setCursorOffset] = useState(0);
  const terminalSize = useTerminalSize();

  // Load existing sources on mount
  useEffect(() => {
    const config = getGlobalConfig();
    setSources(config.apiSources || []);
  }, []);

  const resetForm = () => {
    setName('');
    setUrl('');
    setApiKey('');
    setSelectedIndex(null);
    setError(null);
    setInputValue('');
    setCursorOffset(0);
  };

  const handleMenuSelect = (choice: string) => {
    if (choice === 'add') {
      setStep('add-name');
      resetForm();
    } else if (choice === 'delete') {
      if (sources.length === 0) {
        setError('No API sources to delete.');
        return;
      }
      setStep('delete-select');
      resetForm();
    } else if (choice === 'use') {
      if (sources.length === 0) {
        setError('No API sources available.');
        return;
      }
      setStep('use-select');
      resetForm();
    } else if (choice === 'cancel') {
      props.onDone('API source management cancelled');
    }
  };

  const handleUseSelect = (index: number) => {
    setSelectedIndex(index);
    setInputValue('');
    setCursorOffset(0);
    setStep('confirm-use');
  };

  const handleConfirmUse = (confirm: boolean) => {
    if (confirm && selectedIndex !== null) {
      const sourceToUse = sources[selectedIndex];
      const activated = activateApiSource(sourceToUse.id);
      if (activated) {
        props.onDone(`Now using API source "${sourceToUse.name}". Requests will be sent to ${sourceToUse.baseUrl}`);
      } else {
        setError('Failed to activate API source.');
      }
    } else {
      setStep('menu');
      resetForm();
    }
  };

  const handleAddNameSubmit = (value: string) => {
    if (!value.trim()) {
      setError('Name cannot be empty.');
      return;
    }
    setName(value.trim());
    setError(null);
    setInputValue('');
    setCursorOffset(0);
    setStep('add-url');
  };

  const handleAddUrlSubmit = (value: string) => {
    if (!value.trim()) {
      setError('URL cannot be empty.');
      return;
    }
    // Basic URL validation
    try {
      new URL(value.trim());
    } catch {
      setError('Invalid URL format. Please include protocol (e.g., https://).');
      return;
    }
    setUrl(value.trim());
    setError(null);
    setInputValue('');
    setCursorOffset(0);
    setStep('add-key');
  };

  const handleAddKeySubmit = (value: string) => {
    if (!value.trim()) {
      setError('API key cannot be empty.');
      return;
    }
    setApiKey(value.trim());
    setError(null);
    setInputValue('');
    setCursorOffset(0);
    setStep('confirm-add');
  };

  const handleConfirmAdd = (confirm: boolean) => {
    if (confirm) {
      const newSource: ApiSource = {
        id: randomUUID(),
        name,
        baseUrl: url,
        apiKey,
        isActive: false,
      };
      const updatedSources = [...sources, newSource];
      saveGlobalConfig(current => ({
        ...current,
        apiSources: updatedSources,
      }));
      setSources(updatedSources);
      setError(null);
      props.onDone(`API source "${name}" added successfully.`);
    } else {
      setStep('menu');
      resetForm();
    }
  };

  const handleDeleteSelect = (index: number) => {
    setSelectedIndex(index);
    setInputValue('');
    setCursorOffset(0);
    setStep('confirm-delete');
  };

  const handleConfirmDelete = (confirm: boolean) => {
    if (confirm && selectedIndex !== null) {
      const sourceToDelete = sources[selectedIndex];
      const updatedSources = sources.filter((_, i) => i !== selectedIndex);
      saveGlobalConfig(current => ({
        ...current,
        apiSources: updatedSources,
      }));
      setSources(updatedSources);
      setError(null);
      props.onDone(`API source "${sourceToDelete?.name}" deleted successfully.`);
    } else {
      setStep('menu');
      resetForm();
    }
  };

  const renderContent = () => {
    switch (step) {
      case 'menu':
        return (
          <Box flexDirection="column">
            <Text bold>Select an action:</Text>
            <Text color="cyan">1. Add new API source</Text>
            <Text color="cyan">2. Use an API source</Text>
            <Text color="cyan">3. Delete existing API source</Text>
            <Text color="cyan">4. Cancel</Text>
            {error && <Text color="red">{error}</Text>}
            <Box marginTop={1}>
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={(value) => {
                  const choice = value.trim();
                  if (choice === '1') handleMenuSelect('add');
                  else if (choice === '2') handleMenuSelect('use');
                  else if (choice === '3') handleMenuSelect('delete');
                  else if (choice === '4') handleMenuSelect('cancel');
                  else setError('Invalid choice. Please enter 1, 2, 3, or 4.');
                }}
                focus={true}
                placeholder="Enter choice (1-4)"
                columns={terminalSize.columns}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                showCursor={true}
              />
            </Box>
          </Box>
        );

      case 'add-name':
        return (
          <Box flexDirection="column">
            <Text bold>Add new API source</Text>
            <Text>Enter a name for this API source:</Text>
            {error && <Text color="red">{error}</Text>}
            <Box marginTop={1}>
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={handleAddNameSubmit}
                focus={true}
                placeholder="e.g., My API, OpenRouter, etc."
                columns={terminalSize.columns}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                showCursor={true}
              />
            </Box>
          </Box>
        );

      case 'add-url':
        return (
          <Box flexDirection="column">
            <Text bold>Enter base URL for "{name}":</Text>
            <Text>API endpoint URL (including protocol):</Text>
            {error && <Text color="red">{error}</Text>}
            <Box marginTop={1}>
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={handleAddUrlSubmit}
                focus={true}
                placeholder="e.g., https://api.openai.com/v1"
                columns={terminalSize.columns}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                showCursor={true}
              />
            </Box>
          </Box>
        );

      case 'add-key':
        return (
          <Box flexDirection="column">
            <Text bold>Enter API key for "{name}":</Text>
            <Text>Your API key (will be stored securely):</Text>
            {error && <Text color="red">{error}</Text>}
            <Box marginTop={1}>
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={handleAddKeySubmit}
                focus={true}
                placeholder="API key..."
                columns={terminalSize.columns}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                showCursor={true}
                mask="*"
              />
            </Box>
          </Box>
        );

      case 'confirm-add':
        return (
          <Box flexDirection="column">
            <Text bold>Confirm new API source:</Text>
            <Text>Name: {name}</Text>
            <Text>URL: {url}</Text>
            <Text>Key: {'*'.repeat(Math.min(apiKey.length, 8))}</Text>
            {error && <Text color="red">{error}</Text>}
            <Box marginTop={1}>
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={(value) => {
                  const answer = value.trim().toLowerCase();
                  if (answer === 'y' || answer === 'yes') handleConfirmAdd(true);
                  else if (answer === 'n' || answer === 'no') handleConfirmAdd(false);
                  else setError('Please enter y or n.');
                }}
                focus={true}
                placeholder="Add this source? (y/n)"
                columns={terminalSize.columns}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                showCursor={true}
              />
            </Box>
          </Box>
        );

      case 'delete-select':
        return (
          <Box flexDirection="column">
            <Text bold>Select API source to delete:</Text>
            {sources.map((source, index) => (
              <Text key={source.id} color="cyan">
                {index + 1}. {source.name} ({source.baseUrl})
              </Text>
            ))}
            <Text color="cyan">{sources.length + 1}. Cancel</Text>
            {error && <Text color="red">{error}</Text>}
            <Box marginTop={1}>
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={(value) => {
                  const num = parseInt(value.trim(), 10);
                  if (isNaN(num)) {
                    setError('Please enter a valid number.');
                    return;
                  }
                  if (num >= 1 && num <= sources.length) {
                    handleDeleteSelect(num - 1);
                  } else if (num === sources.length + 1) {
                    setStep('menu');
                    resetForm();
                  } else {
                    setError('Invalid selection.');
                  }
                }}
                focus={true}
                placeholder="Enter number"
                columns={terminalSize.columns}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                showCursor={true}
              />
            </Box>
          </Box>
        );

      case 'confirm-delete':
        const sourceToDelete = sources[selectedIndex!];
        return (
          <Box flexDirection="column">
            <Text bold>Confirm deletion:</Text>
            <Text>Name: {sourceToDelete?.name}</Text>
            <Text>URL: {sourceToDelete?.baseUrl}</Text>
            {error && <Text color="red">{error}</Text>}
            <Box marginTop={1}>
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={(value) => {
                  const answer = value.trim().toLowerCase();
                  if (answer === 'y' || answer === 'yes') handleConfirmDelete(true);
                  else if (answer === 'n' || answer === 'no') handleConfirmDelete(false);
                  else setError('Please enter y or n.');
                }}
                focus={true}
                placeholder="Delete this source? (y/n)"
                columns={terminalSize.columns}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                showCursor={true}
              />
            </Box>
          </Box>
        );

      case 'use-select':
        return (
          <Box flexDirection="column">
            <Text bold>Select API source to use:</Text>
            {sources.map((source, index) => (
              <Text key={source.id} color={source.isActive ? 'green' : 'cyan'}>
                {index + 1}. {source.name} ({source.baseUrl}){source.isActive ? ' [active]' : ''}
              </Text>
            ))}
            <Text color="cyan">{sources.length + 1}. Cancel</Text>
            {error && <Text color="red">{error}</Text>}
            <Box marginTop={1}>
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={(value) => {
                  const num = parseInt(value.trim(), 10);
                  if (isNaN(num)) {
                    setError('Please enter a valid number.');
                    return;
                  }
                  if (num >= 1 && num <= sources.length) {
                    handleUseSelect(num - 1);
                  } else if (num === sources.length + 1) {
                    setStep('menu');
                    resetForm();
                  } else {
                    setError('Invalid selection.');
                  }
                }}
                focus={true}
                placeholder="Enter number"
                columns={terminalSize.columns}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                showCursor={true}
              />
            </Box>
          </Box>
        );

      case 'confirm-use':
        const sourceToUse = sources[selectedIndex!];
        return (
          <Box flexDirection="column">
            <Text bold>Confirm use:</Text>
            <Text>Name: {sourceToUse?.name}</Text>
            <Text>URL: {sourceToUse?.baseUrl}</Text>
            <Text>All API requests will be sent to this endpoint.</Text>
            {error && <Text color="red">{error}</Text>}
            <Box marginTop={1}>
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={(value) => {
                  const answer = value.trim().toLowerCase();
                  if (answer === 'y' || answer === 'yes') handleConfirmUse(true);
                  else if (answer === 'n' || answer === 'no') handleConfirmUse(false);
                  else setError('Please enter y or n.');
                }}
                focus={true}
                placeholder="Use this source? (y/n)"
                columns={terminalSize.columns}
                cursorOffset={cursorOffset}
                onChangeCursorOffset={setCursorOffset}
                showCursor={true}
              />
            </Box>
          </Box>
        );

      default:
        return null;
    }
  };

  return (
    <Dialog
      title="API Source Management"
      onCancel={() => props.onDone('API source management cancelled')}
      color="permission"
    >
      {renderContent()}
    </Dialog>
  );
}