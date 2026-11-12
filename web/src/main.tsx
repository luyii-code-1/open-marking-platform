import './pwaCoordinator'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { App } from './App'
import { uiTheme } from './uiTheme'
import './styles.css'
createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider locale={zhCN} theme={uiTheme}><AntApp><App /></AntApp></ConfigProvider></React.StrictMode>)
