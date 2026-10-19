// A classic script in <head> runs before the stylesheets paint. As a module it would defer and flash the system scheme.
{
  const theme = document.cookie.match(/(?:^|; )rusubon-theme=(light|dark)(?:;|$)/)?.[1];
  if (theme) document.documentElement.dataset.theme = theme;
}
