import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { App } from './App'
import './styles.css'
createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#17655b', colorInfo: '#17655b', colorSuccess: '#268b65', colorBgLayout: '#f3f5f4', borderRadius: 9, fontFamily: 'Inter, "Segoe UI", "Microsoft YaHei", sans-serif' } }}><AntApp><App /></AntApp></ConfigProvider></React.StrictMode>)
