import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'
import ja from './ja.json'
import ko from './ko.json'
import zh from './zh.json'

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
    ko: { translation: ko },
    ja: { translation: ja },
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export default i18n
