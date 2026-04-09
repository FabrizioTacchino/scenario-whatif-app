Estensione di un’applicazione esistente con modulo avanzato di gestione personale, allocazione risorse, costi del personale, saturazione, fabbisogno ruoli e pianificazione futura

1. Contesto reale del progetto

L’applicazione su cui devi lavorare esiste già, è installata localmente sul mio PC ed è già funzionante.
È stata costruita con Cloud Code e oggi gestisce correttamente una logica di pianificazione e confronto scenari relativi alle commesse.

La parte già esistente dell’applicazione gestisce:
uno scenario di baseline;
più scenari alternativi o di confronto;
commesse classificate tra:
backlog = commesse già acquisite;
order intake = commesse potenziali / opportunità future;
una percentuale di acquisizione per ciascuna commessa;
una curva mensilizzata della commessa;
valori come:
actual;
remaining;
valore della produzione;
elementi di confronto economico;
marginalità;
grafici e comparison tra scenari.
Modalità di alimentazione attuale

L’applicazione già oggi viene alimentata tramite importazione di file Excel, trascinati dentro il sistema, da cui legge le commesse e i dati di scenario.

2. Obiettivo della richiesta

Non voglio rifare da zero l’applicazione.
Non voglio alterare il motore esistente.
Non voglio cambiare i calcoli che oggi funzionano già correttamente.

Voglio aggiungere una nuova macro-funzionalità:

un modulo separato e integrato di gestione del personale / allocazione risorse sulle commesse, che si appoggi ai dati e agli scenari già presenti nell’app.

In pratica, voglio introdurre una seconda dimensione nell’applicazione:

oggi l’app gestisce molto bene le commesse e gli scenari economico-produttivi;
voglio aggiungere la dimensione persone / risorse / costo del personale / ruoli / disponibilità / saturazione / fabbisogno.

Questa estensione deve permettermi di:

importare e gestire l’anagrafica delle persone;
assegnare le persone alle commesse;
distribuire il costo del personale sulle commesse;
verificare la saturazione delle risorse nel tempo;
capire chi è sotto-allocato o sovra-allocato;
capire se mancano ruoli su una commessa;
simulare il fabbisogno futuro, soprattutto su order intake;
capire se una risorsa che si libera da una commessa può essere riallocata su un’altra;
capire dove saranno necessarie nuove assunzioni;
vedere l’impatto della probabilità di acquisizione non solo sui ricavi o sulla produzione, ma anche sul personale. 3. Vincoli non negoziabili

Questi punti sono fondamentali.

3.1 La parte esistente non va toccata funziona perfettamente e va lasciata esattamente così come è.

La logica attuale dell’applicazione deve restare completamente invariata.

Non devono cambiare:

i calcoli degli scenari esistenti;
la logica baseline;
la logica backlog / order intake;
la curva actual / remaining;
i risultati economici attuali;
i grafici e i confronti già esistenti;
l’import attuale del file Excel, per la parte già funzionante.
3.2 Il nuovo modulo deve essere non invasivo

La gestione personale deve essere implementata come modulo aggiuntivo, isolato, attivabile/disattivabile, senza impattare il comportamento attuale.

In pratica:

la parte nuova deve leggere quello che già esiste;
deve aggiungere nuove entità, nuove schermate e nuovi calcoli;
ma non deve alterare in alcun modo i risultati attuali della parte già esistente.
3.3 Se il modulo risorse viene disattivato, l’app deve comportarsi esattamente come oggi

Questa è una condizione essenziale.

4. Visione funzionale della nuova estensione

Il nuovo modulo deve introdurre una gestione completa del personale collegato alle commesse.

Voglio poter gestire almeno queste informazioni sulle persone:
identificativo univoco della persona;
codice fiscale come identificativo univoco consigliato, perché è più robusto dell’ID Excel e più sicuro di Cognome+Nome;
eventuale ID legacy importato dal file Excel o da altre basi dati;
cognome;
nome;
società;
BU;
CDC;
VDC;
TDC;
ruolo/mansione;
tipo contratto;
data assunzione;
data termine;
costo medio mensile;
eventuali note;
stato attivo/inattivo.
Voglio poter gestire almeno queste informazioni sulle allocazioni:
persona;
commessa;
scenario;
percentuale di allocazione;
data inizio;
data fine;
eventuale motivazione / note;
origine del dato:
inserito manualmente;
importato;
derivato;
eventuale override consapevole su data fine o regole. 5. Logica fondamentale di allocazione

La nuova estensione deve funzionare in modo rigoroso.

5.1 Regola base

Ogni persona può essere allocata su una o più commesse.
Ogni allocazione deve avere:

persona;
commessa;
percentuale; (una persona può lavorare su due commesse ma su una deve scaricare il 30% e sull'altra il 70% del suo costo)
periodo; (potrebeb avere un senso partire con il periodo di inizio e fine della commessa in modo che qualora si spostino le date delle commesse anche la data di inizio e fine di quella persona potrebbe cambiare, ovviamnte se quella persona è entrata dopo come nuova assunzione avrà la data di quando è entrata e allo stesso modo se ha smesso il rapporto di lavoro non potà essere inserita come data fine la stessa fine del progetto perchè la persona ha smesso di lavorare con noi prima...)
costo medio mensile associato alla persona (inizialmente potremmo basarci su un costo per ruolo ma il costo della persona potrebbe fare override al ruolo)
5.2 Vincolo di saturazione

Per ogni persona, nello stesso periodo, la somma delle percentuali di allocazione non deve superare il 100%.

5.3 Motore temporale

Il motore deve ragionare su base mensile, anche se l’utente inserisce date reali.

Questo significa che internamente deve esistere una logica che, per ogni combinazione:

scenario
commessa
persona
mese

determina:

percentuale allocata;
costo allocato;
costo probabilizzato;
FTE equivalente;
ruolo della persona;
disponibilità residua;
stato di saturazione.
5.4 Regola del mese

Per l’MVP, il sistema deve ragionare con una logica mensile, non giornaliera.

Quindi:

se un’allocazione tocca un mese, quel mese viene considerato attivo per la logica mensile;
in futuro si potrà prevedere una modalità più fine, eventualmente prorata giornaliera, ma non è prioritaria adesso. 6. Integrazione con gli scenari già esistenti

La parte risorse deve essere strettamente integrata con l’applicazione attuale.

Questo significa che:
ogni scenario esistente deve poter avere la propria vista risorse;
ogni commessa già presente in uno scenario deve poter essere arricchita con le assegnazioni del personale;
se duplico uno scenario, devo poter duplicare anche la relativa struttura delle allocazioni;
se cambio una commessa in uno scenario a livello di:
date,
durata,
percentuale di acquisizione,
curva,
classificazione backlog/order intake,
allora anche la parte risorse deve aggiornarsi coerentemente;
la parte risorse non deve vivere come file o mondo separato, ma come estensione nativa dell’app attuale.
Comportamento richiesto in caso di modifica scenario

Se cambia uno scenario già esistente:

le allocazioni devono essere ricalcolate o almeno segnalate come potenzialmente incoerenti;
le dashboard devono riflettere il nuovo stato;
i costi del personale devono adeguarsi;
la parte attuale dell’app non deve rompersi. 7. Effetto della probabilità di acquisizione sul personale

Questo punto è fondamentale.

La probabilità di acquisizione già presente nell’applicazione deve influire anche sulla parte risorse.

Voglio almeno due viste logiche:
Vista piena / teorica

Mostra il fabbisogno reale della commessa al 100%.

Vista probabilizzata

Applica la probabilità di acquisizione della commessa anche al personale.

Esempio

Se una commessa richiede:

2 planner;
1 BIM specialist;
costo pieno mensile totale = 18.000 euro;
probabilità di acquisizione = 50%,

allora il sistema deve poter mostrare:

Vista teorica
3 persone
18.000 euro
3 FTE
Vista probabilizzata
costo personale ponderato = 9.000 euro
FTE ponderati = 1,5
Questa logica deve essere applicabile soprattutto a:
commesse di order intake;
confronti tra scenari;
analisi manageriali;
simulazioni di carico futuro;
analisi del fabbisogno. 8. Cosa voglio ottenere operativamente

La nuova estensione deve permettermi di vedere con chiarezza:

8.1 Costo del personale per commessa

Per ogni commessa voglio sapere:

quante persone ci lavorano;
con quale ruolo;
con quale percentuale;
in quali mesi;
con quale costo mensile;
con quale costo totale;
con quale costo probabilizzato.
8.2 Saturazione delle persone

Per ogni persona voglio sapere:

se è saturata al 100%;
se è sotto-allocata;
se è sovra-allocata;
in quali mesi è disponibile;
in quali mesi è sovraccarica;
quando termina una sua allocazione;
quando diventa riutilizzabile.
8.3 Copertura ruoli

Per ogni commessa voglio sapere:

quali ruoli sono coperti;
quali ruoli mancano;
se c’è un eccesso di certe figure;
se esistono colli di bottiglia per ruolo.
8.4 Fabbisogno futuro

Voglio poter capire:

quante persone serviranno in futuro;
di quali ruoli;
in quali mesi;
quanto posso coprire con personale interno già esistente;
cosa richiederà nuove assunzioni.
8.5 Riallocazioni possibili

Quando una commessa finisce o si riduce:

devo vedere quali persone si liberano;
da quale data;
con quale ruolo;
con quale costo;
se possono essere spostate su altre commesse esistenti o future;
se esiste domanda compatibile del loro ruolo altrove. 9. Scheda di dettaglio commessa

Ogni commessa deve avere una scheda risorse dedicata.

Dentro questa scheda voglio vedere:
dati base della commessa già presenti nell’app;
tipo commessa:
backlog
order intake
eventuale altro tipo;
percentuale di acquisizione;
elenco persone assegnate;
ruolo di ogni persona;
costo medio mensile della persona;
percentuale allocata sulla commessa;
periodo di assegnazione;
costo mensile allocato;
costo totale allocato;
costo probabilizzato;
FTE totali mensili;
andamento temporale delle risorse sulla commessa;
ruoli presenti;
ruoli mancanti;
eventuali ruoli in eccesso;
evidenza dei mesi con scopertura;
cronologia delle modifiche sulle allocazioni.
Questa scheda deve essere:
chiara;
leggibile;
esportabile;
utile anche per management, non solo per uso tecnico. 10. Scheda di dettaglio persona

Ogni persona deve avere una scheda allocazioni dedicata.

Dentro questa scheda voglio vedere:
dati anagrafici base;
codice fiscale come ID univoco consigliato;
eventuale ID legacy;
ruolo/mansione;
costo medio mese;
stato attivo/inattivo;
date di disponibilità;
elenco commesse su cui lavora;
scenario di appartenenza;
percentuali di allocazione;
timeline mensile delle allocazioni;
costo allocato per commessa;
costo totale assorbito;
saturazione mensile;
saturazione annuale;
mesi sotto-allocati;
mesi sovra-allocati;
mesi liberi;
backlog/order intake/overhead su cui è impegnata;
potenziali finestre di riutilizzo.
Questa scheda deve servire anche per:
pianificazione;
riallocazione;
analisi disponibilità;
analisi del carico. 11. Gestione del fabbisogno e recruiting

Questa è una parte strategica, non un accessorio.

Per le commesse future, soprattutto order intake, voglio che il sistema sia in grado di aiutarmi a ragionare su:

fabbisogno teorico di risorse;
ruoli necessari;
mese in cui serviranno;
capacità interna disponibile;
capacità interna liberabile;
gap di copertura;
nuove assunzioni necessarie;
costo delle assunzioni richieste;
impatto per BU, società, funzione o ruolo.
Voglio almeno queste distinzioni:
fabbisogno coperto da personale già disponibile;
fabbisogno coperto da riallocazione possibile;
fabbisogno non coperto;
fabbisogno che richiede assunzioni;
fabbisogno teorico al 100%;
fabbisogno probabilizzato in funzione della percentuale di acquisizione. 12. Importazione dati persone e allocazioni

La nuova estensione deve supportare almeno due modalità di alimentazione.

Modalità 1 – gestione manuale

Voglio poter:

creare e modificare persone manualmente;
assegnare manualmente le persone alle commesse;
impostare percentuali;
impostare date di inizio e fine;
aggiornare costi e ruoli;
gestire note e override.
Modalità 2 – import massivo da Excel

Voglio poter trascinare un file Excel che contenga almeno:

identificativo persona;
codice fiscale;
cognome;
nome;
ruolo;
costo medio mese;
società / BU / eventuali attributi;
commessa;
scenario;
percentuale;
data inizio;
data fine.
Comportamento richiesto in fase di import:
preview dell’import;
validazione preventiva;
segnalazione errori;
segnalazione warning;
mappatura colonne;
conferma esplicita prima del salvataggio;
mantenimento storico importazioni;
tracciabilità della provenienza del dato. 13. Regole di validazione

Non voglio una funzionalità permissiva che sporca i dati.

Errori bloccanti

Devono bloccare il salvataggio:

persona inesistente;
commessa inesistente;
scenario inesistente;
percentuale <= 0;
percentuale > 100 per singola riga;
data inizio > data fine;
somma percentuali > 100% per la stessa persona nello stesso mese;
allocazioni incompatibili temporalmente se portano a over-allocation;
codice fiscale duplicato dove non ammesso;
record gravemente incoerenti.
Warning non bloccanti

Devono essere visibili ma non necessariamente bloccare:

costo medio mese mancante o nullo;
ruolo non valorizzato;
persona allocata oltre la data termine;
allocazione oltre la fine prevista della commessa;
mesi sotto-allocati;
gap di copertura;
dati importati con ID legacy mancanti;
disallineamenti tra fonti diverse.
Evidenze richieste

La UI deve mostrare chiaramente:

errori in rosso;
warning in giallo;
residuo disponibile;
saturazione mensile. 14. Modello logico del motore

Il motore deve basarsi su una struttura chiara e verificabile.

Entità principali richieste
Persone

Contiene l’anagrafica della risorsa.

Commesse

Usa le commesse già presenti nel sistema esistente.

Scenari

Usa gli scenari già presenti nel sistema esistente.

Allocazioni

Rappresenta l’associazione tra persona e commessa in un certo periodo con una certa percentuale.

Vista mensile derivata

Per ogni persona, commessa, scenario e mese, il sistema deve generare un record logico che rappresenti:

percentuale attiva;
costo attivo;
costo probabilizzato;
FTE equivalente;
stato di saturazione;
disponibilità residua. 15. Possibile logica evoluta “base + eccezioni”

Questa parte è opzionale ma fortemente consigliata, perché deriva da una criticità reale vista nel file Excel di allocazione risorse.

Problema

In Excel, per rappresentare casi come:

persona base su una commessa al 100%;
eccezione temporanea su un’altra commessa al 70%;
si è costretti a spezzare manualmente più righe per ricostruire anche il residuo.
Soluzione evoluta consigliata

Supportare due modalità:

Modalità esplicita

Ogni stato logico viene inserito con una riga distinta.

Modalità base + eccezioni

L’utente può definire:

una commessa base;
una percentuale base, tipicamente 100%;
un periodo base;
una o più eccezioni temporanee.

Il sistema calcola automaticamente il residuo sulla commessa base.

Esempio

Base:

Commessa R8
100%
da gennaio a dicembre

Eccezione:

Bellagio
70%
da gennaio ad aprile

Risultato mensile derivato:

gennaio-aprile:
Bellagio 70%
R8 30%
maggio-dicembre:
R8 100%
Regola di sicurezza

Se le eccezioni superano la base:

errore bloccante.
Nota importante

Questa logica deve essere opzionale, perché esistono casi reali multi-commessa senza base dominante.

16. Dashboard e viste manageriali

Oltre al dettaglio operativo, voglio viste direzionali leggibili e utili.

KPI che voglio vedere
costo totale personale per scenario;
costo personale backlog;
costo personale order intake;
costo personale teorico;
costo personale probabilizzato;
persone disponibili per mese;
persone completamente allocate;
persone sottoallocate;
persone sovraallocate;
FTE per commessa e per mese;
ruoli più richiesti;
ruoli mancanti;
colli di bottiglia per BU, società, funzione o ruolo;
commesse con maggiore assorbimento risorse;
commesse con maggiore rischio di scopertura;
impatto sul costo del personale al variare di:
probabilità di acquisizione;
durata commessa;
shift temporali;
cambio scenario. 17. UI desiderata

La UI deve essere professionale, concreta e utile.

Non voglio
una demo bella ma vuota;
una vista difficile da leggere;
logiche nascoste;
numeri impossibili da spiegare.
Voglio almeno queste sezioni nuove
Risorse / Persone
elenco anagrafica;
dettaglio persona;
timeline allocazioni;
saturazione mensile e annuale.
Commesse / Risorse
dettaglio commessa;
elenco persone assegnate;
costo personale;
ruoli presenti / mancanti;
andamento mensile.
Pianificazione
editor allocazioni;
assegnazione manuale;
import massivo;
filtri per scenario, BU, ruolo, società;
anteprima impatti.
Capacità / Fabbisogno
disponibilità interna;
risorse liberabili;
fabbisogno futuro;
gap di copertura;
potenziali assunzioni.
Dashboard
KPI sintetici;
grafici;
confronto scenari;
vista management. 18. Audit, spiegabilità e tracciabilità

La nuova parte deve essere verificabile.

Voglio sapere sempre:
chi ha modificato un dato;
quando;
valore precedente;
valore nuovo;
origine del dato;
se il dato è manuale, importato o derivato;
da quale file o importazione proviene.
Voglio anche una logica “spiega il numero”

Per i numeri più importanti il sistema deve poter mostrare:

da quali allocazioni deriva;
quali mesi considera;
quale percentuale usa;
quale costo usa;
se la vista è teorica o probabilizzata;
se il numero è stato derivato da riallocazione o residuo. 19. Export richiesti

Voglio una logica di export pulita e professionale.

Export Excel

Deve essere possibile esportare:

anagrafica persone;
allocazioni;
dettaglio commessa;
dettaglio persona;
riepilogo costi risorse;
saturazione;
fabbisogno;
assunzioni suggerite;
viste per scenario.
Export PDF

Dove utile, voglio report PDF per management, ad esempio:

saturazione persone;
piano risorse per commessa;
fabbisogno mensile;
gap ruoli;
riepilogo scenario. 20. Requisiti tecnici e architetturali
La nuova feature deve essere:
modulare;
estendibile;
non invasiva;
coerente con l’architettura già esistente;
pronta ad accogliere evoluzioni future.
Evoluzioni future che voglio lasciare aperte

In futuro potrei voler aggiungere:

competenze;
seniority;
costi variabili nel tempo;
scenari di assunzione;
ferie / assenze;
capacità disponibile reale;
calendari;
prorata giornaliero;
matching competenze-commesse.

Quindi il design del modulo non deve essere una toppa, ma una base robusta.

21. Acceptance criteria

Considererò il lavoro riuscito se il modulo soddisfa questi punti:

si integra nell’app esistente senza rompere nulla;
non cambia i risultati della parte già funzionante;
introduce la gestione anagrafica persone;
permette allocazioni percentuali per periodo;
distribuisce correttamente il costo mensile del personale;
ragiona per mese;
gestisce saturazione e disponibilità;
mostra costo teorico e costo probabilizzato;
integra correttamente backlog e order intake;
permette analisi di riallocazione;
permette analisi di fabbisogno e recruiting;
produce schede commessa e schede persona utili;
supporta import ed export;
mantiene audit e spiegabilità;
resta modulare, estendibile e non invasivo. 22. Richiesta finale

Non voglio un prototipo superficiale.
Non voglio un’aggiunta approssimativa.
Voglio una estensione costruita con mentalità da:

planner;
cost controller;
data modeler;
sviluppatore serio di prodotto.
La filosofia corretta è questa:
non toccare ciò che oggi funziona;
aggiungere una nuova dimensione all’app;
far emergere la dimensione persone dentro gli scenari già esistenti;
rendere il dato leggibile, verificabile e utile;
trasformare l’app da strumento di sola analisi commesse a strumento anche di pianificazione risorse e capacità.
Punto finale non negoziabile

La nuova funzionalità deve essere un modulo aggiuntivo isolato, integrato con gli scenari esistenti ma senza alterare in alcun modo la logica attuale dell’applicazione.
