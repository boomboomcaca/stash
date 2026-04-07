import React, { useState, useEffect } from "react";
import { Button, Alert, Form } from "react-bootstrap";
import { FormattedMessage, useIntl } from "react-intl";
import { useApolloClient, gql } from "@apollo/client";
import { useToast } from "src/hooks/Toast";
import { SettingSection } from "./SettingSection";
import { BooleanSetting, StringSetting, NumberSetting } from "./Inputs";
import { LoadingIndicator } from "../Shared/LoadingIndicator";
import { Icon } from "../Shared/Icon";
import {
  faCheck,
  faTimes,
  faSync,
  faClosedCaptioning,
} from "@fortawesome/free-solid-svg-icons";

interface ISubtitleConfig {
  // General settings
  enabled: boolean;
  default_language: string;
  skip_if_exists: boolean;
  timeout: number;
  folder_path: string;
  // Whisper settings
  whisper_enabled: boolean;
  whisper_url: string;
  whisper_translate: boolean;
  whisper_ai_normalize: boolean;
}

export const SettingsSubtitlePanel: React.FC = () => {
  const intl = useIntl();
  const Toast = useToast();
  const client = useApolloClient();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<boolean | null>(null);
  const [generating, setGenerating] = useState(false);

  const [config, setConfig] = useState<ISubtitleConfig>({
    enabled: true,
    default_language: "en",
    skip_if_exists: true,
    timeout: 300,
    folder_path: "",
    whisper_enabled: true,
    whisper_url: "http://localhost:8000",
    whisper_translate: true,
    whisper_ai_normalize: false,
  });

  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadConfig() {
    setLoading(true);
    try {
      const response = await client.query({
        query: gql`
          query SubtitleConfig {
            subtitleConfig {
              enabled
              default_language
              skip_if_exists
              timeout
              folder_path
              whisper_enabled
              whisper_url
              whisper_translate
              whisper_ai_normalize
            }
          }
        `,
        fetchPolicy: "network-only",
      });
      if (response.data?.subtitleConfig) {
        setConfig(response.data.subtitleConfig);
      }
    } catch (e) {
      console.error("Failed to load subtitle config:", e);
    } finally {
      setLoading(false);
    }
  }

  async function saveConfig() {
    setSaving(true);
    try {
      const response = await client.mutate({
        mutation: gql`
          mutation ConfigureSubtitle($input: SubtitleConfigInput!) {
            configureSubtitle(input: $input) {
              enabled
              default_language
              skip_if_exists
              timeout
              folder_path
              whisper_enabled
              whisper_url
              whisper_translate
              whisper_ai_normalize
            }
          }
        `,
        variables: {
          input: {
            enabled: config.enabled,
            default_language: config.default_language,
            skip_if_exists: config.skip_if_exists,
            timeout: config.timeout,
            folder_path: config.folder_path,
            whisper_enabled: config.whisper_enabled,
            whisper_url: config.whisper_url,
            whisper_translate: config.whisper_translate,
            whisper_ai_normalize: config.whisper_ai_normalize,
          },
        },
      });
      if (response.data?.configureSubtitle) {
        setConfig(response.data.configureSubtitle);
        Toast.success(intl.formatMessage({ id: "toast.saved_settings" }));
      }
    } catch (e) {
      Toast.error(e);
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const response = await client.query({
        query: gql`
          query TestSubtitleConnection {
            testSubtitleConnection
          }
        `,
        fetchPolicy: "network-only",
      });
      setTestResult(response.data?.testSubtitleConnection ?? false);
    } catch (e) {
      setTestResult(false);
    } finally {
      setTesting(false);
    }
  }

  async function generateAllSubtitles() {
    setGenerating(true);
    try {
      const response = await client.mutate({
        mutation: gql`
          mutation AutoGenerateSubtitles(
            $language: String
            $folderPath: String
          ) {
            autoGenerateSubtitles(language: $language, folderPath: $folderPath)
          }
        `,
        variables: {
          language: config.default_language,
          folderPath: config.folder_path || undefined,
        },
      });
      if (response.data?.autoGenerateSubtitles) {
        Toast.success(
          intl.formatMessage(
            { id: "config.subtitle.generation_started" },
            { defaultMessage: "Subtitle generation started" }
          )
        );
      }
    } catch (e) {
      Toast.error(e);
    } finally {
      setGenerating(false);
    }
  }

  if (loading) return <LoadingIndicator />;

  return (
    <>
      <h4>
        <Icon icon={faClosedCaptioning} className="mr-2" />
        <FormattedMessage
          id="config.subtitle.title"
          defaultMessage="Subtitle Settings"
        />
      </h4>

      <SettingSection
        headingID="config.subtitle.general_settings"
        subHeadingID=""
      >
        <BooleanSetting
          id="enabled"
          headingID="config.subtitle.enabled"
          checked={config.enabled}
          onChange={(v) => setConfig({ ...config, enabled: v })}
        />

        <StringSetting
          id="default_language"
          headingID="config.subtitle.default_language"
          subHeadingID="config.subtitle.default_language_desc"
          value={config.default_language}
          onChange={(v) => setConfig({ ...config, default_language: v })}
        />

        <BooleanSetting
          id="skip_if_exists"
          headingID="config.subtitle.skip_if_exists"
          checked={config.skip_if_exists}
          onChange={(v) => setConfig({ ...config, skip_if_exists: v })}
        />

        <NumberSetting
          id="timeout"
          headingID="config.subtitle.timeout"
          subHeadingID="config.subtitle.timeout_desc"
          value={config.timeout}
          onChange={(v) => setConfig({ ...config, timeout: v })}
        />
      </SettingSection>

      <SettingSection
        headingID="config.subtitle.whisper_settings"
        subHeadingID=""
      >
        <Alert variant="info">
          <FormattedMessage
            id="config.subtitle.whisper_info"
            defaultMessage="Whisper generates subtitles locally using AI."
          />
        </Alert>

        <BooleanSetting
          id="whisper_enabled"
          headingID="config.subtitle.whisper_enabled"
          checked={config.whisper_enabled}
          onChange={(v) => setConfig({ ...config, whisper_enabled: v })}
        />

        <StringSetting
          id="whisper_url"
          headingID="config.subtitle.whisper_url"
          subHeadingID="config.subtitle.whisper_url_desc"
          value={config.whisper_url}
          onChange={(v) => setConfig({ ...config, whisper_url: v })}
        />

        <BooleanSetting
          id="whisper_translate"
          headingID="config.subtitle.whisper_translate"
          subHeadingID="config.subtitle.whisper_translate_desc"
          checked={config.whisper_translate}
          onChange={(v) => setConfig({ ...config, whisper_translate: v })}
        />

        <BooleanSetting
          id="whisper_ai_normalize"
          headingID="config.subtitle.whisper_ai_normalize"
          subHeadingID="config.subtitle.whisper_ai_normalize_desc"
          checked={config.whisper_ai_normalize}
          onChange={(v) => setConfig({ ...config, whisper_ai_normalize: v })}
        />

        <div className="setting-row">
          <div>
            <Button
              variant="secondary"
              onClick={testConnection}
              disabled={testing || !config.whisper_enabled}
            >
              {testing ? (
                <LoadingIndicator inline small />
              ) : (
                <FormattedMessage
                  id="config.subtitle.test_connection"
                  defaultMessage="Test Whisper Connection"
                />
              )}
            </Button>
            {testResult !== null && (
              <span className="ml-2">
                <Icon
                  icon={testResult ? faCheck : faTimes}
                  color={testResult ? "green" : "red"}
                />
                <FormattedMessage
                  id={
                    testResult
                      ? "config.subtitle.connected"
                      : "config.subtitle.connection_failed"
                  }
                  defaultMessage={
                    testResult ? "Connected" : "Connection Failed"
                  }
                />
              </span>
            )}
          </div>
        </div>
      </SettingSection>

      <SettingSection headingID="config.subtitle.actions" subHeadingID="">
        <div className="setting-row">
          <Button variant="primary" onClick={saveConfig} disabled={saving}>
            {saving ? (
              <LoadingIndicator inline small />
            ) : (
              <FormattedMessage id="actions.save" defaultMessage="Save" />
            )}
          </Button>
        </div>
        <div className="setting-row mt-3">
          <div
            className="d-flex align-items-center flex-wrap"
            style={{ gap: "0.5rem" }}
          >
            <Form.Control
              type="text"
              placeholder={intl.formatMessage({
                id: "config.subtitle.folder_path_placeholder",
                defaultMessage:
                  "Folder path filter (optional, e.g. /media/videos)",
              })}
              value={config.folder_path}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setConfig({ ...config, folder_path: e.currentTarget.value })
              }
              style={{ maxWidth: "400px" }}
            />
            <Button
              variant="secondary"
              onClick={generateAllSubtitles}
              disabled={generating || !config.enabled}
            >
              {generating ? (
                <LoadingIndicator inline small />
              ) : (
                <>
                  <Icon icon={faSync} className="mr-1" />
                  <FormattedMessage
                    id="config.subtitle.generate_all"
                    defaultMessage="Generate Subtitles for All Scenes"
                  />
                </>
              )}
            </Button>
          </div>
        </div>
      </SettingSection>
    </>
  );
};
