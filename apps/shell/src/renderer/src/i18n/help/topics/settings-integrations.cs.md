# Nastavení, jazyk, motiv a integrace MCP

## Otevření nastavení

Řádek účtu vlevo dole na domovské stránce otevře panel nastavení (při nepřihlášení ukazuje Přihlásit se). Má šest částí: Účet, Model AI, AI média a vyhledávání, Obecné, Integrace a O aplikaci.

![Nastavení ▸ Obecné, kde žijí jazyk, motiv, automatické ukládání a přepínač statistik používání](img/settings-general.png)

Konfigurace modelů má vlastní kapitolu; v části **AI média a vyhledávání** zapínáte pro každého poskytovatele generování obrázků, analýzu obrázků, analýzu videí, webové vyhledávání a hledání místních souborů.

## Jazyk

- Nastavení nabízí **22 jazyků rozhraní**: angličtina, zjednodušená čínština, japonština, korejština, francouzština, němčina, španělština, thajština, indonéština, ruština, arabština, portugalština, italština, polština, čeština, nizozemština, malajština, hebrejština, hindština, tradiční čínština, vietnamština, turečtina.
- Změna působí okamžitě a zůstává zachována; nativní pruh nabídek se znovu sestaví v novém jazyce.

## Motiv

Světlý / Tmavý / Podle systému. Volba Podle systému sleduje vzhled operačního systému a editory se přeoblekují současně bez blikání.

## Obecné

- **Pozice postranního panelu AI** (vlevo nebo vpravo), **Velikost textu panelu AI** a **Kontrola pravopisu v chatu AI**.
- **Otevírat panel AI v nových dokumentech** — vypnuto, nový dokument začíná se složeným panelem, na jedno kliknutí.
- **Automaticky ukládat všechny dokumenty** zapne ve výchozím stavu automatické ukládání v každém editoru; pro jedno okno ho můžete i nadále vypnout.
- **Umístění pro ukládání** s tlačítkem **Změnit** a **Výchozí aplikace pro dokumenty Office**, aby CMLG Office přebíral .docx / .xlsx / .pptx.

## AI média a vyhledávání

Nejsou to přepínače — každá schopnost si vybere dodavatele, který ji poskytuje, a klíč i základní URL dodavatele se zadávají jednou a sdílejí se:

- **Webové vyhledávání**, **Generování obrázků**, **Analýza obrázků** a **Analýza videí**, každá s poskytovatelem, modelem, klíčem a základní URL.
- **Místní hledání souborů** běží na tomto počítači. Pod ním je **sémantické přeřazení výsledků** **ve výchozím stavu vypnuté**. Po zapnutí se úryvky 20 nejlepších místních výsledků — až 1 200 znaků každého dokumentu plus názvy souborů a složek — odešlou rozhodovacímu modelu této instalace na platformě digitálních zaměstnanců CMLG AI, účtovanému na API klíč přihlášeného zaměstnance, a přeřadí se podle relevance. Když je vypnuté, nic neopouští zařízení.

## O aplikaci

- **Verze**, odkaz na projekt na GitHubu a tlačítko **Dát hvězdičku na GitHubu**.
- **Kanál aktualizací**: Stabilní nebo Beta. Změna se projeví ihned a vyvolá kontrolu aktualizace; instalaci z kanálu Beta nevrátí zpět na Stabilní.

## Přiřazení jako výchozí aplikace

Nastavení může zaregistrovat CMLG Office jako aplikaci pro soubory .docx / .xlsx / .pptx / .pdf a podobné (registrace výchozí aplikace na úrovni systému; potvrzení, když o něj systém požádá).

## Informace o softwaru třetích stran a aktualizace

- Nápověda ▸ Informace o softwaru třetích stran: úplný přehled licencí open source dodávaných s aplikací.
- Nápověda ▸ Zkontrolovat aktualizace…: spustí ruční kontrolu; novější verze vyzve k instalaci.

## Přihlášení ke Genspark

- Místo přihlášení (v nastavení nebo v seznamu cloudových projektů) používá postup s **kódem zařízení**: CMLG Office zobrazí kód a otevře přihlašovací stránku v prohlížeči; po dokončení postup pokračuje automaticky.
- Přihlášení slouží pouze k: seznamu cloudových projektů a modelům hostovaným Gensparkem. Bez něj fungují dál všechny místní funkce i vlastní modely.
- Odhlášení je jedno kliknutí v nastavení.

## Integrace MCP (pro pokročilé uživatele a klienty AI)

**Integrace** je panel, který propojí CMLG Office s programovým agentem, a má o tom vlastní kapitolu: Připojení programového agenta. Zkrátka — vyberte cestu (příkazová řádka, nebo MCP), řiďte se danou částí a pak začněte nový chat a zeptejte se.

![Nastavení ▸ Integrace: tři kroky, pak řádky dovedností a možnosti MCP](img/settings-integrations.png)

Pod **Místní HTTP server** umí aplikace server spustit sama — přepínač zapnutí a port — a část **Pokročilé** přidá adresu pro kontrolu stavu a soubor protokolu, místo aby ho nechala na pomocníkovi. Naslouchá pouze na localhostu.

## Přehled příkazů

| Příkaz               | Co dělá                     |
| -------------------- | --------------------------- |
| `genoffice <soubor>` | otevře soubor               |
| `genoffice mcp`      | spustí místní server MCP    |
| `genoffice --help`   | všechny příkazy a přepínače |
