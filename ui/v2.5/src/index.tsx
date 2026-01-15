import { ApolloProvider } from "@apollo/client";
import ReactDOM from "react-dom";
import { HashRouter, BrowserRouter } from "react-router-dom";
import React, { useState } from "react";
import { App } from "./App";
import { getClient } from "./core/StashService";
import {
  baseURL,
  getPlatformURL,
  isTauriEnv,
  isServerConfigured,
} from "./core/createClient";
import { ServerConfig } from "./components/ServerConfig";
import "./index.scss";
import * as serviceWorker from "./serviceWorker";

// Tauri 模式下的应用入口
const TauriApp: React.FC = () => {
  const [configured, setConfigured] = useState(isServerConfigured());

  if (!configured) {
    return (
      <ServerConfig
        onConnected={() => {
          setConfigured(true);
          // 重新加载以使用新的服务器配置
          window.location.reload();
        }}
      />
    );
  }

  return (
    <HashRouter>
      <ApolloProvider client={getClient()}>
        <App />
      </ApolloProvider>
    </HashRouter>
  );
};

// 标准 Web 模式下的应用入口
const WebApp: React.FC = () => {
  return (
    <>
      <link
        rel="stylesheet"
        type="text/css"
        href={getPlatformURL("css").toString()}
      />
      <BrowserRouter basename={baseURL}>
        <ApolloProvider client={getClient()}>
          <App />
        </ApolloProvider>
      </BrowserRouter>
    </>
  );
};

// 根据环境选择渲染的组件
if (isTauriEnv()) {
  ReactDOM.render(<TauriApp />, document.getElementById("root"));
} else {
  ReactDOM.render(<WebApp />, document.getElementById("root"));

  const script = document.createElement("script");
  script.src = getPlatformURL("javascript").toString();
  document.body.appendChild(script);
}

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: http://bit.ly/CRA-PWA
serviceWorker.unregister();
