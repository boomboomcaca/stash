import React, { useState, useEffect } from "react";
import { Button, Alert } from "react-bootstrap";
import { FormattedMessage, useIntl } from "react-intl";
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
  auto_generate_on_scan: boolean;
  // OpenSubtitles settings
  opensubtitles_enabled: boolean;
  opensubtitles_api_key: string;
  // Whisper settings
  whisper_enabled: boolean;
  whisper_url: string;
  whisper_translate: boolean;
}

export const SettingsSubtitlePanel: React.FC = () => {
  const intl = useIntl();
  const Toast = useToast();

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
    auto_generate_on_scan: true,
    opensubtitles_enabled: false,
    opensubtitles_api_key: "",
    whisper_enabled: true,
    whisper_url: "http://localhost:8000",
    whisper_translate: true,
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
          query: `query { subtitleConfig { enabled default_language skip_if_exists timeout auto_generate_on_scan opensubtitles_enabled opensubtitles_api_key whisper_enabled whisper_url whisper_translate } }`,
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
              enabled default_language skip_if_exists timeout auto_generate_on_scan opensubtitles_enabled opensubtitles_api_key whisper_enabled whisper_url whisper_translate
            }
          }`,
          variables: {
            input: {
              enabled: config.enabled,
              default_language: config.default_language,
              skip_if_exists: config.skip_if_exists,
              timeout: config.timeout,
              auto_generate_on_scan: config.auto_generate_on_scan,
              opensubtitles_enabled: config.opensubtitles_enabled,
              opensubtitles_api_key: config.opensubtitles_api_key,
              whisper_enabled: config.whisper_enabled,
              whisper_url: config.whisper_url,
              whisper_translate: config.whisper_translate,
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

        <BooleanSetting
          id="auto_generate_on_scan"
          headingID="config.subtitle.auto_generate_on_scan"
          subHeadingID="config.subtitle.auto_generate_on_scan_desc"
          checked={config.auto_generate_on_scan}
          onChange={(v) => setConfig({ ...config, auto_generate_on_scan: v })}
        />
      </SettingSection>

      <SettingSection
        headingID="config.subtitle.opensubtitles_settings"
        subHeadingID=""
      >
        <Alert variant="info">
          <FormattedMessage
            id="config.subtitle.opensubtitles_info"
            defaultMessage="OpenSubtitles fetches subtitles from online database. Get your free API key at opensubtitles.com. When enabled, it will try online first, then fall back to Whisper."
          />
        </Alert>

        <BooleanSetting
          id="opensubtitles_enabled"
          headingID="config.subtitle.opensubtitles_enabled"
          checked={config.opensubtitles_enabled}
          onChange={(v) => setConfig({ ...config, opensubtitles_enabled: v })}
        />

        <StringSetting
          id="opensubtitles_api_key"
          headingID="config.subtitle.opensubtitles_api_key"
          subHeadingID="config.subtitle.opensubtitles_api_key_desc"
          value={config.opensubtitles_api_key}
          onChange={(v) => setConfig({ ...config, opensubtitles_api_key: v })}
        />
      </SettingSection>

      <SettingSection
        headingID="config.subtitle.whisper_settings"
        subHeadingID=""
      >
        <Alert variant="info">
          <FormattedMessage
            id="config.subtitle.whisper_info"
            defaultMessage="Whisper generates subtitles locally using AI. Used as fallback when OpenSubtitles fails or is disabled."
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
