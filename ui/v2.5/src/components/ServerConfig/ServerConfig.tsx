import React, { useState } from "react";
import { Button, Form, Alert, Spinner, Card } from "react-bootstrap";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import "./ServerConfig.scss";

interface IServerConfigProps {
  onConnected: () => void;
}

export const isTauri = () => {
  return typeof window !== "undefined" && "__TAURI__" in window;
};

// 使用 Tauri fetch 或原生 fetch
const httpFetch = async (
  url: string,
  options: RequestInit
): Promise<Response> => {
  if (isTauri()) {
    return tauriFetch(url, {
      method: options.method || "GET",
      headers: options.headers as Record<string, string>,
      body:
        options.body instanceof FormData
          ? undefined
          : (options.body as string | undefined),
    });
  }
  return fetch(url, options);
};

export const getStoredServerUrl = (): string | null => {
  return localStorage.getItem("stash_server_url");
};

export const getStoredApiKey = (): string | null => {
  return localStorage.getItem("stash_api_key");
};

export const setStoredServerConfig = (url: string, apiKey: string) => {
  localStorage.setItem("stash_server_url", url);
  localStorage.setItem("stash_api_key", apiKey);
};

export const clearStoredServerConfig = () => {
  localStorage.removeItem("stash_server_url");
  localStorage.removeItem("stash_api_key");
};

export const ServerConfig: React.FC<IServerConfigProps> = ({ onConnected }) => {
  const [serverUrl, setServerUrl] = useState(getStoredServerUrl() || "");
  const [useCredentials, setUseCredentials] = useState(false);
  // Never hardcode credentials here: this component is bundled and shipped, so
  // any literal username/password would leak in the distributed build.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState(getStoredApiKey() || "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const normalizeUrl = (url: string): string => {
    let normalized = url.trim();
    if (
      !normalized.startsWith("http://") &&
      !normalized.startsWith("https://")
    ) {
      normalized = "http://" + normalized;
    }
    if (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  };

  const testConnection = async (url: string, key: string) => {
    setLoading(true);
    setError(null);

    try {
      const graphqlUrl = `${normalizeUrl(url)}/graphql`;
      const response = await httpFetch(graphqlUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ApiKey: key,
        },
        body: JSON.stringify({
          query: "{ version { version } }",
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.data?.version?.version) {
          setStoredServerConfig(normalizeUrl(url), key);
          onConnected();
          return;
        }
      }

      if (response.status === 401 || response.status === 403) {
        setError("API Key 无效或权限不足");
      } else {
        setError(`连接失败: HTTP ${response.status}`);
      }
    } catch (e) {
      setError(`连接失败: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const loginWithCredentials = async () => {
    setLoading(true);
    setError(null);

    const normalizedUrl = normalizeUrl(serverUrl);

    try {
      // Step 1: 登录获取 session
      const loginResponse = await httpFetch(`${normalizedUrl}/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `username=${encodeURIComponent(
          username
        )}&password=${encodeURIComponent(password)}`,
        credentials: "include",
      });

      if (!loginResponse.ok) {
        setError("用户名或密码错误");
        setLoading(false);
        return;
      }

      // Step 2: 获取 API Key
      const credResponse = await httpFetch(`${normalizedUrl}/graphql`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "{ configuration { general { apiKey } } }",
        }),
        credentials: "include",
      });

      const credData = await credResponse.json();
      let fetchedApiKey = credData.data?.configuration?.general?.apiKey;

      // Step 3: 如果没有 API Key，生成一个
      if (!fetchedApiKey) {
        const genResponse = await httpFetch(`${normalizedUrl}/graphql`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: "mutation { generateAPIKey }",
          }),
          credentials: "include",
        });
        const genData = await genResponse.json();
        fetchedApiKey = genData.data?.generateAPIKey;
      }

      if (fetchedApiKey) {
        setApiKey(fetchedApiKey);
        setStoredServerConfig(normalizedUrl, fetchedApiKey);
        onConnected();
      } else {
        setError("无法获取 API Key");
      }
    } catch (e) {
      console.error("Login error:", e);
      const errorMsg =
        e instanceof Error
          ? e.message
          : typeof e === "string"
          ? e
          : JSON.stringify(e);
      setError(`登录失败: ${errorMsg || "未知错误"}`);
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();

    if (useCredentials) {
      await loginWithCredentials();
    } else {
      await testConnection(serverUrl, apiKey);
    }
  };

  return (
    <div className="server-config-container">
      <Card className="server-config-card">
        <Card.Header>
          <h4>🎬 Stash 服务器配置</h4>
        </Card.Header>
        <Card.Body>
          <Form onSubmit={handleConnect}>
            <Form.Group className="mb-3">
              <Form.Label>服务器地址</Form.Label>
              <Form.Control
                type="text"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="http://192.168.1.100:9999"
              />
            </Form.Group>

            <Form.Group className="mb-3">
              <Form.Check
                type="switch"
                id="use-credentials"
                label="使用用户名密码登录"
                checked={useCredentials}
                onChange={(e) => setUseCredentials(e.target.checked)}
              />
            </Form.Group>

            {useCredentials ? (
              <>
                <Form.Group className="mb-3">
                  <Form.Label>用户名</Form.Label>
                  <Form.Control
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </Form.Group>
                <Form.Group className="mb-3">
                  <Form.Label>密码</Form.Label>
                  <Form.Control
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Form.Group>
                <small className="text-muted">
                  登录成功后将自动获取或生成 API Key
                </small>
              </>
            ) : (
              <Form.Group className="mb-3">
                <Form.Label>API Key</Form.Label>
                <Form.Control
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="可选，如果服务器需要认证"
                />
              </Form.Group>
            )}

            {error && (
              <Alert variant="danger" className="mt-3">
                {error}
              </Alert>
            )}

            <Button
              variant="primary"
              type="submit"
              disabled={loading}
              className="mt-3 w-100"
            >
              {loading ? (
                <>
                  <Spinner size="sm" animation="border" className="me-2" />
                  连接中...
                </>
              ) : (
                "连接服务器"
              )}
            </Button>
          </Form>
        </Card.Body>
      </Card>
    </div>
  );
};

export default ServerConfig;
