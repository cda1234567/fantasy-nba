# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: g4_player.spec.ts >> g4 player: lineup editor + injury edge cases
- Location: g4_player.spec.ts:172:5

# Error details

```
Test timeout of 1320000ms exceeded.
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - banner [ref=e2]:
    - heading "NBA Fantasy 模擬器" [level=1] [ref=e3]
    - button "聯盟 qa-r2-g4" [ref=e5] [cursor=pointer]:
      - generic [ref=e6]: 聯盟
      - generic "qa-r2-g4" [ref=e7]
      - img [ref=e8]
    - generic [ref=e10]:
      - generic [ref=e12]: 連線中
      - generic "應用版本" [ref=e13]: v0.5.23
  - generic [ref=e14]:
    - navigation "主選單" [ref=e15]:
      - link "選秀" [ref=e16] [cursor=pointer]:
        - /url: "#draft"
        - generic [ref=e17]: D
        - generic [ref=e18]: 選秀
      - link "隊伍" [ref=e19] [cursor=pointer]:
        - /url: "#teams"
        - generic [ref=e20]: T
        - generic [ref=e21]: 隊伍
      - link "自由球員" [ref=e22] [cursor=pointer]:
        - /url: "#fa"
        - generic [ref=e23]: F
        - generic [ref=e24]: 自由球員
      - link "聯盟" [ref=e25] [cursor=pointer]:
        - /url: "#league"
        - generic [ref=e26]: L
        - generic [ref=e27]: 聯盟
      - link "賽程" [ref=e28] [cursor=pointer]:
        - /url: "#schedule"
        - generic [ref=e29]: S
        - generic [ref=e30]: 賽程
    - main [active] [ref=e31]:
      - generic [ref=e32]: 載入選秀狀態中...
    - complementary "活動記錄" [ref=e33]:
      - generic [ref=e34]:
        - heading "活動" [level=2] [ref=e35]
        - button "重新整理活動記錄" [ref=e36] [cursor=pointer]:
          - img [ref=e37]
      - list [ref=e39]:
        - listitem [ref=e40]:
          - generic [ref=e41]: 01:06:57 PM
          - text: 第 119 天（第 17 週）比賽結束
        - listitem [ref=e42]:
          - generic [ref=e43]: 01:06:57 PM
          - text: 🌟 Luka Dončić 單場爆發 100.1 FP（T4）
        - listitem [ref=e44]:
          - generic [ref=e45]: 01:06:57 PM
          - text: 💀 T6 陷入三連敗
        - listitem [ref=e46]:
          - generic [ref=e47]: 01:06:57 PM
          - text: 💀 T2 陷入三連敗
        - listitem [ref=e48]:
          - generic [ref=e49]: 01:06:57 PM
          - text: 🔥 T0 三連勝!
        - listitem [ref=e50]:
          - generic [ref=e51]: 01:06:57 PM
          - text: 💥 大屠殺！T1 以 159.6 分血洗 T2
        - listitem [ref=e52]:
          - generic [ref=e53]: 01:06:57 PM
          - text: 💥 大屠殺！T7 以 95.5 分血洗 T3
        - listitem [ref=e54]:
          - generic [ref=e55]: 01:06:57 PM
          - text: 💥 大屠殺！T4 以 589.2 分血洗 T6
        - listitem [ref=e56]:
          - generic [ref=e57]: 01:06:57 PM
          - text: 💥 大屠殺！T0 以 293.4 分血洗 T5
        - listitem [ref=e58]:
          - generic [ref=e59]: 01:06:57 PM
          - text: T7 AI 排出先發（contrarian）
        - listitem [ref=e60]:
          - generic [ref=e61]: 01:06:57 PM
          - text: T6 AI 排出先發（vet）
        - listitem [ref=e62]:
          - generic [ref=e63]: 01:06:57 PM
          - text: T5 AI 排出先發（youth）
        - listitem [ref=e64]:
          - generic [ref=e65]: 01:06:57 PM
          - text: T4 AI 排出先發（balanced）
        - listitem [ref=e66]:
          - generic [ref=e67]: 01:06:57 PM
          - text: T3 AI 排出先發（stars_scrubs）
        - listitem [ref=e68]:
          - generic [ref=e69]: 01:06:57 PM
          - text: T2 AI 排出先發（punt_to）
        - listitem [ref=e70]:
          - generic [ref=e71]: 01:06:57 PM
          - text: T1 AI 排出先發（bpa）
        - listitem [ref=e72]:
          - generic [ref=e73]: 01:06:51 PM
          - text: 第 119 天（第 17 週）比賽結束
        - listitem [ref=e74]:
          - generic [ref=e75]: 01:06:51 PM
          - text: 🌟 Luka Dončić 單場爆發 100.1 FP（T4）
        - listitem [ref=e76]:
          - generic [ref=e77]: 01:06:51 PM
          - text: 💀 T6 陷入三連敗
        - listitem [ref=e78]:
          - generic [ref=e79]: 01:06:51 PM
          - text: 💀 T2 陷入三連敗
        - listitem [ref=e80]:
          - generic [ref=e81]: 01:06:51 PM
          - text: 🔥 T0 三連勝!
        - listitem [ref=e82]:
          - generic [ref=e83]: 01:06:51 PM
          - text: 💥 大屠殺！T1 以 227.6 分血洗 T2
        - listitem [ref=e84]:
          - generic [ref=e85]: 01:06:51 PM
          - text: 💥 大屠殺！T7 以 156.4 分血洗 T3
        - listitem [ref=e86]:
          - generic [ref=e87]: 01:06:51 PM
          - text: 💥 大屠殺！T4 以 558 分血洗 T6
        - listitem [ref=e88]:
          - generic [ref=e89]: 01:06:51 PM
          - text: 💥 大屠殺！T0 以 338.9 分血洗 T5
        - listitem [ref=e90]:
          - generic [ref=e91]: 01:06:51 PM
          - text: T7 AI 排出先發（contrarian）
        - listitem [ref=e92]:
          - generic [ref=e93]: 01:06:51 PM
          - text: T6 AI 排出先發（vet）
        - listitem [ref=e94]:
          - generic [ref=e95]: 01:06:51 PM
          - text: T5 AI 排出先發（youth）
        - listitem [ref=e96]:
          - generic [ref=e97]: 01:06:51 PM
          - text: T4 AI 排出先發（balanced）
        - listitem [ref=e98]:
          - generic [ref=e99]: 01:06:51 PM
          - text: T3 AI 排出先發（stars_scrubs）
```