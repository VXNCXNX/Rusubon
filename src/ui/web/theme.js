// A classic script in <head> runs before the stylesheets paint. As a module it would defer and flash the system scheme.
try {
  const theme = JSON.parse(localStorage.getItem("rusubon:theme"));
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {}
