export function deviceLabel(agent = '') {
  const tablet = /iPad|Tablet|Android(?!.*Mobile)/i.test(agent);
  const phone = /iPhone|iPod|Android.*Mobile|Windows Phone/i.test(agent);
  const os = /Windows Phone/.test(agent) ? 'Windows Phone' : /Windows/.test(agent) ? 'Windows' : /Android/.test(agent) ? 'Android' : /iPhone|iPad|iPod/.test(agent) ? 'iOS / iPadOS' : /Macintosh|Mac OS/.test(agent) ? 'macOS' : /CrOS/.test(agent) ? 'ChromeOS' : /Linux/.test(agent) ? 'Linux' : 'Неизвестная ОС';
  const browser = /CompanyAssistant|Electron\//.test(agent) ? 'Приложение' : /Edg(?:A|iOS)?\//.test(agent) ? 'Edge' : /YaBrowser\//.test(agent) ? 'Яндекс Браузер' : /SamsungBrowser\//.test(agent) ? 'Samsung Internet' : /OPR\/|OPiOS\//.test(agent) ? 'Opera' : /Firefox\/|FxiOS\//.test(agent) ? 'Firefox' : /Chrome\/|CriOS\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Браузер';
  const kind = tablet ? 'Планшет' : phone ? 'Телефон' : /Windows|Macintosh|Linux|CrOS/.test(agent) ? 'Компьютер' : 'Устройство';
  return `${kind} · ${os} · ${browser}`;
}

export function geoLabel(reader, ip) {
  if (!reader) return 'Геолокация временно недоступна';
  try {
    const item = reader.get(ip);
    return [item?.country?.names?.ru || item?.country?.names?.en, item?.city?.names?.ru || item?.city?.names?.en].filter(Boolean).join(', ') || 'Не определено';
  } catch { return 'Не определено'; }
}
