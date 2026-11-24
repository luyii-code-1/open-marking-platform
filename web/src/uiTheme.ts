import { theme, type ThemeConfig } from 'antd'
import type { ResolvedTheme } from './themeMode'

export function getUiTheme(resolved: ResolvedTheme = 'light'): ThemeConfig {
  const dark = resolved === 'dark'
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: dark ? '#3b82f6' : '#0866ff',
      colorInfo: dark ? '#3b82f6' : '#0866ff',
      colorSuccess: dark ? '#22c55e' : '#218755',
      ...(dark
        ? {
            colorBgBase: '#0f141c',
            colorBgContainer: '#141a24',
            colorBgElevated: '#1b2330',
            colorBgLayout: '#0b0f16',
            colorText: '#e6edf3',
            colorTextHeading: '#f0f6fc',
            colorTextSecondary: '#9fb0c3',
            colorTextTertiary: '#7d8fa3',
            colorTextPlaceholder: '#6e7f93',
            colorBorder: '#2a3444',
            colorBorderSecondary: '#202938',
          }
        : {
            colorText: '#141414',
            colorTextHeading: '#141414',
            colorTextSecondary: '#434343',
            colorTextTertiary: '#595959',
            colorTextPlaceholder: '#767676',
            colorBorder: '#d9d9d9',
            colorBgLayout: '#f5f7fa',
          }),
      borderRadius: 4,
      fontFamily: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
      fontSize: 14,
      lineHeight: 22 / 14,
      fontSizeHeading2: 20,
      fontSizeHeading3: 18,
      fontSizeHeading4: 15,
      controlHeight: 36,
      controlHeightSM: 28,
      controlHeightLG: 40,
    },
    components: {
      Card: { headerHeight: 42, headerHeightSM: 36, headerFontSize: 15, bodyPadding: 14, bodyPaddingSM: 12 },
      Table: {
        cellFontSize: 14,
        cellFontSizeMD: 14,
        cellFontSizeSM: 14,
        cellPaddingBlock: 16,
        cellPaddingInline: 16,
        cellPaddingBlockMD: 12,
        cellPaddingInlineMD: 12,
        cellPaddingBlockSM: 8,
        headerBg: dark ? '#1a2230' : '#f5f5f5',
        headerColor: dark ? '#e6edf3' : '#141414',
        borderColor: dark ? '#253042' : '#e8e8e8',
        rowHoverBg: dark ? '#1d2738' : '#f5f9ff',
      },
      Select: { optionHeight: 36, optionFontSize: 14, optionPadding: '7px 12px' },
      Dropdown: { paddingBlock: 8 },
      List: { itemPadding: '14px 0', itemPaddingSM: '10px 0' },
      Form: { itemMarginBottom: 16, verticalLabelPadding: '0 0 6px' },
      Menu: {
        itemHeight: 40,
        itemBorderRadius: 3,
        itemMarginBlock: 2,
        itemSelectedBg: dark ? 'rgba(59, 130, 246, 0.2)' : '#edf4ff',
        darkItemBg: '#141a24',
        darkSubMenuItemBg: '#141a24',
        darkItemSelectedBg: 'rgba(59, 130, 246, 0.22)',
        groupTitleFontSize: 13,
      },
      Tabs: { horizontalMargin: '0 0 12px 0', horizontalItemPadding: '8px 0' },
      Modal: { titleFontSize: 16 },
      Statistic: { titleFontSize: 14, contentFontSize: 24 },
    },
  }
}

export const uiTheme: ThemeConfig = getUiTheme('light')
