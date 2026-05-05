import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { installOpenAIOAuthTokens } from '../cli/handlers/auth.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { setClipboard } from '../ink/termio/osc.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import { Box, Link, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { getSSLErrorHint } from '../services/api/errorUtils.js'
import { sendNotification } from '../services/notifier.js'
import { OpenAIOAuthService } from '../services/openaiAuth/index.js'
import { getOpenAIOAuthTokens } from '../services/openaiAuth/storage.js'
import { logError } from '../utils/log.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Spinner } from './Spinner.js'
import TextInput from './TextInput.js'

type Props = {
  onDone(): void
  startingMessage?: string
}

type OpenAILoginStatus =
  | { state: 'ready_to_start' }
  | { state: 'waiting_for_login'; url: string }
  | { state: 'success'; warning?: string | null }
  | { state: 'error'; message: string; toRetry?: OpenAILoginStatus }
  | { state: 'about_to_retry'; nextState: OpenAILoginStatus }

const PASTE_HERE_MSG = 'Paste code here if prompted > '

export function OpenAILoginFlow({
  onDone,
  startingMessage,
}: Props): React.ReactNode {
  const [oauthService] = useState(() => new OpenAIOAuthService())
  const [status, setStatus] = useState<OpenAILoginStatus>({
    state: 'ready_to_start',
  })

  // After a few seconds we suggest the user to copy/paste url if the
  // browser did not open automatically.
  const [showPastePrompt, setShowPastePrompt] = useState(false)
  const [urlCopied, setUrlCopied] = useState(false)
  const [pastedCode, setPastedCode] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const terminal = useTerminalNotification()
  const textInputColumns = useTerminalSize().columns - PASTE_HERE_MSG.length - 1

  // Handle Enter to continue on success state
  useKeybinding(
    'confirm:yes',
    () => {
      logEvent('tengu_openai_oauth_success', {})
      onDone()
    },
    {
      context: 'Confirmation',
      isActive: status.state === 'success',
    },
  )

  // Handle Enter to retry on error state
  useKeybinding(
    'confirm:yes',
    () => {
      if (status.state === 'error' && status.toRetry) {
        setPastedCode('')
        setStatus({
          state: 'about_to_retry',
          nextState: status.toRetry,
        })
      }
    },
    {
      context: 'Confirmation',
      isActive: status.state === 'error' && !!status.toRetry,
    },
  )

  // Clipboard copy: type 'c' to copy the auth URL
  useEffect(() => {
    if (
      pastedCode === 'c' &&
      status.state === 'waiting_for_login' &&
      showPastePrompt &&
      !urlCopied
    ) {
      void setClipboard(status.url).then(raw => {
        if (raw) process.stdout.write(raw)
        setUrlCopied(true)
        setTimeout(setUrlCopied, 2000, false)
      })
      setPastedCode('')
    }
  }, [pastedCode, status, showPastePrompt, urlCopied])

  // Retry logic
  useEffect(() => {
    if (status.state === 'about_to_retry') {
      const timer = setTimeout(setStatus, 1000, status.nextState)
      return () => clearTimeout(timer)
    }
  }, [status])

  const handleSubmitCode = useCallback(
    async (value: string, url: string) => {
      try {
        const [authorizationCode, state] = value.split('#')
        if (!authorizationCode || !state) {
          setStatus({
            state: 'error',
            message: 'Invalid code. Please make sure the full code was copied',
            toRetry: { state: 'waiting_for_login', url },
          })
          return
        }

        logEvent('tengu_openai_oauth_manual_entry', {})
        oauthService.handleManualAuthCodeInput({
          authorizationCode,
          state,
        })
      } catch (err: unknown) {
        logError(err)
        setStatus({
          state: 'error',
          message: (err as Error).message,
          toRetry: { state: 'waiting_for_login', url },
        })
      }
    },
    [oauthService],
  )

  const startOAuth = useCallback(async () => {
    try {
      logEvent('tengu_openai_oauth_flow_start', {})
      const tokens = await oauthService.startOAuthFlow(
        async url => {
          setStatus({ state: 'waiting_for_login', url })
          setTimeout(setShowPastePrompt, 3000, true)
        },
      )
      const warning = await installOpenAIOAuthTokens(tokens)
      setStatus({ state: 'success', warning })
      void sendNotification(
        {
          message: 'yuanclaw OpenAI login successful',
          notificationType: 'auth_success',
        },
        terminal,
      )
    } catch (error) {
      const errorMessage = (error as Error).message
      const sslHint = getSSLErrorHint(error)
      logError(error)
      setStatus({
        state: 'error',
        message: sslHint ?? errorMessage,
        toRetry: { state: 'ready_to_start' },
      })
      logEvent('tengu_openai_oauth_error', {
        error: errorMessage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ssl_error: sslHint !== null,
      })
    }
  }, [oauthService, terminal])

  const pendingOAuthStartRef = useRef(false)

  useEffect(() => {
    if (
      status.state === 'ready_to_start' &&
      !pendingOAuthStartRef.current
    ) {
      pendingOAuthStartRef.current = true
      process.nextTick(() => {
        void startOAuth()
        pendingOAuthStartRef.current = false
      })
    }
  }, [status.state, startOAuth])

  // Cleanup OAuth service when component unmounts
  useEffect(() => {
    return () => {
      oauthService.cleanup()
    }
  }, [oauthService])

  const account = getOpenAIOAuthTokens()

  return (
    <Box flexDirection="column" gap={1}>
      {status.state === 'waiting_for_login' && showPastePrompt && (
        <Box flexDirection="column" key="urlToCopy" gap={1} paddingBottom={1}>
          <Box paddingX={1}>
            <Text dimColor>
              Browser didn&apos;t open? Use the url below to sign in{' '}
            </Text>
            {urlCopied ? (
              <Text color="success">(Copied!)</Text>
            ) : (
              <Text dimColor>
                <KeyboardShortcutHint shortcut="c" action="copy" parens />
              </Text>
            )}
          </Box>
          <Link url={status.url}>
            <Text dimColor>{status.url}</Text>
          </Link>
        </Box>
      )}

      <Box flexDirection="column" gap={1}>
        <Text bold>
          {startingMessage ??
            'Claude Code can also run through your ChatGPT subscription via OpenAI auth.'}
        </Text>

        {status.state === 'waiting_for_login' && !showPastePrompt && (
          <Box>
            <Spinner />
            <Text>Opening browser to sign in to OpenAI…</Text>
          </Box>
        )}

        {status.state === 'waiting_for_login' && showPastePrompt && (
          <Box>
            <Text>{PASTE_HERE_MSG}</Text>
            <TextInput
              value={pastedCode}
              onChange={setPastedCode}
              onSubmit={(value: string) =>
                handleSubmitCode(value, status.url)
              }
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              columns={textInputColumns}
              mask="*"
            />
          </Box>
        )}

        {status.state === 'about_to_retry' && (
          <Box flexDirection="column" gap={1}>
            <Text color="permission">Retrying…</Text>
          </Box>
        )}

        {status.state === 'success' && (
          <Box flexDirection="column">
            {account?.email ? (
              <Text dimColor>
                Logged in as <Text>{account.email}</Text>
              </Text>
            ) : null}
            {status.warning ? (
              <Text color="warning">{status.warning}</Text>
            ) : null}
            <Text color="success">
              Login successful. Press <Text bold>Enter</Text> to continue…
            </Text>
          </Box>
        )}

        {status.state === 'error' && (
          <Box flexDirection="column" gap={1}>
            <Text color="error">OpenAI OAuth error: {status.message}</Text>
            {status.toRetry && (
              <Box marginTop={1}>
                <Text color="permission">
                  Press <Text bold>Enter</Text> to retry.
                </Text>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </Box>
  )
}
