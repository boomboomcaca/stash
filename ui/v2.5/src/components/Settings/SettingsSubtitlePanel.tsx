import React, { useState, useEffect } from "react";
import { Button, Form, Alert } from "react-bootstrap";
import { FormattedMessage, useIntl } from "react-intl";
import { useToast } from "src/hooks/Toast";
import { SettingSection } from "./SettingSection";
import { BooleanSetting, StringSetting, NumberSetting } from "./Inputs";
import { LoadingIndicator } from "../Shared/LoadingIndicator";
import { Icon } from "../Shared/Icon";
import { faCheck, faTimes, faSync, faClosedCaptioning } from "@fortawesome/free-solid-svg-icons";

interface SubtitleConfig {
  whisper_url: string;
  enabled: boolean;
  auto_generate: boolean;
  default_language: string;
  skip_if_exists: boolean;
  timeout: number;
}

export const SettingsSubtitlePanel: React.FC = () => {
  const intl = useIntl();
  const Toast = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<boolean | null>(null);
  const [generating, setGenerating] = useState(false);

  const [config, setConfig] = useState<SubtitleConfig>({
    whisper_url: "http://localhost:8000",
    enabled: true,
    auto_generate: false,
    default_language: "en",
    skip_if_exists: true,
    timeout: 300,
  });

  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    setLoading(true);
    try {
      const response = await fetch("/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query { subtitleConfig { whisper_url enabled auto_generate default_language skip_if_exists timeout } }`,
        }),
      });
      const data = await response.json();
      if (data.data?.subtitleConfig) {
        setConfig(data.data.subtitleConfig);
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
      const response = await fetch("/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation ConfigureSubtitle($input: SubtitleConfigInput!) {
            configureSubtitle(input: $input) {
              whisper_url enabled auto_generate default_language skip_if_exists timeout
            }
          }`,
          variables: {
            input: {
              whisper_url: config.whisper_url,
              enabled: config.enabled,
              auto_generate: config.auto_generate,
              default_language: config.default_language,
              skip_if_exists: config.skip_if_exists,
              timeout: config.timeout,
            },
          },
        }),
      });
      const data = await response.json();
      if (data.data?.configureSubtitle) {
        setConfig(data.data.configureSubtitle);
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
      const response = await fetch("/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query { testSubtitleConnection }`,
        }),
      });
      const data = await response.json();
      setTestResult(data.data?.testSubtitleConnection ?? false);
    } catch (e) {
      setTestResult(false);
    } finally {
      setTesting(false);
    }
  }

  async function generateAllSubtitles() {
    setGenerating(true);
    try {
      const response = await fetch("/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation AutoGenerateSubtitles($language: String) {
            autoGenerateSubtitles(language: $language)
          }`,
          variables: {
            language: config.default_language,
          },
        }),
      });
      const data = await response.json();
      if (data.data?.autoGenerateSubtitles) {
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

      <SettingSection headingID="config.subtitle.whisper_settings" subHeadingID="">
        <StringSetting
          id="whisper_url"
          headingID="config.subtitle.whisper_url"
          subHeadingID="config.subtitle.whisper_url_desc"
          value={config.whisper_url}
          onChange={(v) => setConfig({ ...config, whisper_url: v })}
        />

        <div className="setting-row">
          <div>
            <Button
              variant="secondary"
              onClick={testConnection}
              disabled={testing}
            >
              {testing ? (
                <LoadingIndicator inline small />
              ) : (
                <FormattedMessage
                  id="config.subtitle.test_connection"
                  defaultMessage="Test Connection"
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
                  id={testResult ? "config.subtitle.connected" : "config.subtitle.connection_failed"}
                  defaultMessage={testResult ? "Connected" : "Connection Failed"}
                />
              </span>
            )}
          </div>
        </div>

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

      <SettingSection headingID="config.subtitle.actions" subHeadingID="">
        <div className="setting-row">
          <Button variant="primary" onClick={saveConfig} disabled={saving}>
            {saving ? (
              <LoadingIndicator inline small />
            ) : (
              <FormattedMessage id="actions.save" defaultMessage="Save" />
            )}
          </Button>
          <Button
            variant="secondary"
            className="ml-2"
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
      </SettingSection>
    </>
  );
};
