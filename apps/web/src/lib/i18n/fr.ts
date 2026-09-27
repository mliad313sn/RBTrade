import type { MessageKey } from './en';

/**
 * Novice view copy, French. Typed against the English keys: a missing or extra key fails the
 * typecheck, and `pnpm --filter @kora/web i18n:check` fails CI. Keep variables and markup identical.
 */
export const fr: Record<MessageKey, string> = {
  // ---- Shell ----
  'shell.skip': 'Aller au contenu',
  'shell.homeLink': 'Accueil Kora',
  'shell.nav.main': 'Principal',
  'shell.nav.mobile': 'Principal (mobile)',
  'nav.home': 'Accueil',
  'nav.practice': 'S’entraîner',
  'nav.autoInvest': 'Robots',
  'nav.learn': 'Apprendre',
  'shell.env': 'Argent d’entraînement',
  'shell.envAria': 'Environnement : argent d’entraînement (simulation)',
  'shell.lang.label': 'Langue',
  'shell.banner.title': 'Le trading peut vous faire perdre de l’argent.',
  'shell.banner.read': 'Lire les risques',
  'shell.banner.placeholder': 'Le chiffre [XX] % sera fourni par notre équipe conformité.',
  'shell.paused.title': 'Prix en pause.',
  'shell.paused.body':
    'Vous êtes hors ligne. Kora n’affiche aucun nouveau prix et ne passe aucun trade avant votre retour en ligne.',
  'shell.switched.title': 'Vue changée.',
  'shell.switched.body':
    'Vue simple : même compte et même instrument. Les types d’ordres avancés et le créateur de robots sont cachés. Chaque trade montre d’abord la perte maximale.',
  'shell.switched.dismiss': 'Fermer',
  'mode.label': 'Mode d’affichage',
  'mode.simple': 'Simple',
  'mode.pro': 'Pro',
  'mode.error': 'Impossible de changer de vue. Réessayez.',
  'mode.needsAssessment.title': 'La vue Pro demande d’abord un court test',
  'mode.needsAssessment.body':
    'Les outils Pro sont réservés aux comptes qui ont réussi ce test. D’ici là, vous restez dans la vue simple.',
  'mode.proRoute.title': 'Cet écran fait partie de la vue Pro',
  'mode.proRoute.bodyTrader':
    'Vous êtes dans la vue simple. Passez en Pro pour utiliser cet écran.',
  'mode.proRoute.bodyNovice':
    'La vue Pro s’ouvre quand vous avez réussi un court test sur les risques du trading.',
  'mode.proRoute.switch': 'Passer en Pro',
  'mode.proRoute.assess': 'Faire le test',
  'mode.proRoute.home': 'Retour à l’accueil',
  'meta.check': 'Test en 5 questions',
  'meta.lesson': 'Leçon',
  'meta.welcome': 'Bienvenue',
  'meta.settings': 'Réglages',
  'meta.appropriateness': 'Débloquer le trading Pro',
  // IRTC R5-12: évaluation (traduction appr.q.* en attente de revue Conformité, OQ-C1).
  'appr.q.title': 'Évaluation du caractère approprié du trading Pro',
  'appr.q.intro':
    'Questions fictives (SIMULATED) en attente de revue par la Conformité (OQ-C1). Ce court test vérifie que vous comprenez les risques d’un trading rapide et avec effet de levier avant d’ouvrir le terminal Pro. Vos réponses sont notées sur notre serveur et ne sont pas conservées ; seuls votre score et la version du questionnaire sont gardés.',
  'appr.q.leverage.prompt':
    'Vous ouvrez une position de 30 000 avec 1 000 de marge (1:30). Le prix bouge de 2 % contre vous. Que devient à peu près votre marge ?',
  'appr.q.leverage.a': 'Je perds environ 2 % de mes 1 000 de marge (environ 20).',
  'appr.q.leverage.b': 'Je perds environ 600, soit 60 % de ma marge.',
  'appr.q.leverage.c': 'Rien, car les pertes ne comptent que quand je ferme.',
  'appr.q.stop_gap.prompt':
    'Votre stop loss est à 100. Le marché clôture à 101 et rouvre le lendemain à 95. À quel prix votre stop sera-t-il le plus probablement exécuté ?',
  'appr.q.stop_gap.a': 'Exactement 100 : un stop est toujours exécuté à son prix.',
  'appr.q.stop_gap.b':
    'Vers 95, le prochain prix disponible, donc la perte est plus grande que prévu.',
  'appr.q.stop_gap.c': 'Il n’est pas exécuté tant que le prix ne revient pas à 100.',
  'appr.q.costs.prompt':
    'Quels coûts réduisent le résultat d’un trade avec effet de levier gardé plusieurs jours ?',
  'appr.q.costs.a': 'Seulement la commission à l’ouverture.',
  'appr.q.costs.b':
    'Le spread, les commissions et le financement de nuit (swap) pour chaque nuit où la position reste ouverte.',
  'appr.q.costs.c': 'Aucun : le trading fictif et avec effet de levier n’a pas de coûts.',
  'appr.q.margin_call.prompt':
    'Vos pertes augmentent et vos fonds propres passent sous la marge dont vos positions ont besoin. Que peut-il se passer ?',
  'appr.q.margin_call.a': 'Des positions peuvent être fermées automatiquement à perte.',
  'appr.q.margin_call.b': 'Le courtier doit attendre que le marché remonte.',
  'appr.q.margin_call.c': 'Les pertes sont toujours limitées à la marge que j’ai déposée.',
  'appr.q.position_size.prompt':
    'Vous voulez risquer au plus 1 % d’un compte de 10 000 sur un trade avec un stop à 50 points. Chaque point vaut 1 par unité. Quelle est la taille maximale ?',
  'appr.q.position_size.a': '2 unités (2 × 50 = 100, soit 1 % de 10 000).',
  'appr.q.position_size.b': '20 unités.',
  'appr.q.position_size.c': 'Autant d’unités que ma marge le permet.',
  'appr.q.volatility.prompt':
    'Une annonce économique majeure est prévue dans cinq minutes. Que se passe-t-il le plus probablement autour de la publication ?',
  'appr.q.volatility.a': 'Les spreads restent les mêmes et les prix bougent lentement.',
  'appr.q.volatility.b':
    'Les spreads peuvent s’élargir et les prix sauter, donc mes ordres peuvent être exécutés loin de ce que j’attends.',
  'appr.q.volatility.c': 'Le marché ferme pendant les annonces.',
  'appr.q.robots.prompt':
    'Le backtest d’un robot de trading montre une courbe de capital régulière et en hausse. Que devez-vous supposer ?',
  'appr.q.robots.a': 'Le robot continuera à produire les mêmes rendements en réel.',
  'appr.q.robots.b':
    'Les résultats passés et simulés ne garantissent pas les résultats futurs ; le trading réel peut perdre de l’argent.',
  'appr.q.robots.c': 'Un robot ne peut pas perdre plus que le pire jour du backtest.',
  'appr.q.loss_capacity.prompt': 'Quel argent est approprié pour trader avec effet de levier ?',
  'appr.q.loss_capacity.a':
    'De l’argent que je peux me permettre de perdre sans toucher à mes dépenses essentielles.',
  'appr.q.loss_capacity.b': 'Mon épargne de précaution, car les gains sont rapides.',
  'appr.q.loss_capacity.c': 'De l’argent emprunté, pour augmenter la taille de mes positions.',
  'appr.topic.leverage': 'Effet de levier',
  'appr.topic.stop_gap': 'Ordres stop et gaps',
  'appr.topic.costs': 'Coûts',
  'appr.topic.margin_call': 'Marge',
  'appr.topic.position_size': 'Taille de position',
  'appr.topic.volatility': 'Volatilité et actualités',
  'appr.topic.robots': 'Trading automatisé',
  'appr.topic.loss_capacity': 'Capacité à perdre',
  'appr.loading': 'Chargement du test…',
  'appr.loadError.title': 'Chargement impossible.',
  'appr.loadError.body': 'Le test n’a pas pu être chargé. Réessayez plus tard.',
  'appr.simulated': 'Questions SIMULATED · en attente de revue par la Conformité',
  'appr.meta':
    'Version {version} · note minimale {pass} % · après un échec, vous pourrez réessayer dans {hours} heures.',
  'appr.done.title': 'Le trading Pro est déjà débloqué.',
  'appr.done.body': 'Votre compte a le rôle de trader.',
  'appr.passed.title': 'Réussi avec {score} %.',
  'appr.passed.body':
    'Vous avez réussi. Ensuite, reconnectez-vous et activez la connexion en deux étapes.',
  'appr.passed.next': 'Redirection vers la connexion…',
  'appr.failed.title': 'Non réussi : {score} % (note minimale {pass} %).',
  'appr.failed.body': 'Relisez les sujets ci-dessous, puis réessayez plus tard.',
  'appr.review': 'À revoir : {topics}.',
  'appr.retryAfter': 'Vous pourrez réessayer après le {when}.',
  'appr.cooldown.title': 'Merci d’attendre avant de réessayer.',
  'appr.cooldown.body':
    'Votre dernier essai n’a pas réussi. Vous pourrez réessayer après le {when}.',
  'appr.submitError.title': 'Envoi impossible.',
  'appr.submitError.body': 'Un problème est survenu. Réessayez.',
  'appr.submit': 'Envoyer mes réponses',
  'appr.answerAll': 'Répondez à toutes les questions pour envoyer.',
  'user.menu': 'Menu du compte de {name}',
  'user.unlockPro': 'Débloquer le trading Pro',
  'user.settings': 'Réglages',
  'user.audit': 'Journal d’activité',
  'user.signOut': 'Se déconnecter',
  'user.twoStepOn': 'connexion en deux étapes activée',
  'kill.button': 'Tout arrêter',
  'kill.help':
    'Maintenez 1,5 seconde, ou touchez une fois, pour ouvrir le menu d’arrêt. Touches : maintenez Contrôle, Maj et K.',
  'kill.title': 'Tout arrêter : que voulez-vous arrêter ?',
  'kill.desc': 'Chaque choix est enregistré dans votre journal d’activité. Argent d’entraînement.',
  'kill.scopes': 'Que faut-il arrêter',
  'kill.scope.robots.title': 'Arrêter mes robots',
  'kill.scope.robots.detail': 'Les robots arrêtent de trader. Vos trades ouverts restent ouverts.',
  'kill.scope.robots_cancel.title': 'Arrêter les robots et annuler les ordres en attente',
  'kill.scope.robots_cancel.detail':
    'Les robots s’arrêtent et les ordres pas encore exécutés sont annulés.',
  'kill.scope.robots_cancel_flatten.title':
    'Arrêter les robots, annuler les ordres et fermer tous les trades',
  'kill.scope.robots_cancel_flatten.detail':
    'Tout est arrêté et chaque trade ouvert est fermé maintenant.',
  'kill.keys': 'Touches : maintenez',
  'kill.done': 'Arrêté. Les robots sont stoppés.',
  'kill.doneOrders': '{n} ordres en attente annulés.',
  'kill.doneClosed': '{n} trades fermés.',
  'kill.donePending': '{n} seront fermés quand le marché sera sûr.',
  'kill.doneAudit': 'Enregistré comme activité n° {id}.',
  'kill.failed': 'Cela n’a pas marché. Réessayez.',
  'hold.instruction': 'Maintenez {s} s, ou touchez une fois puis confirmez.',
  'hold.holding': 'Maintien…',
  'hold.confirmed': 'C’est fait',
  'hold.confirmTitle': 'Vous êtes sûr ?',
  'hold.confirmBody': 'La prochaine fois, vous pouvez aussi maintenir le bouton.',
  'hold.confirm': 'Oui, continuer',
  'hold.cancel': 'Annuler',
  'halt.title': 'Le trading est arrêté : {scope}.',
  'halt.since': 'Depuis {time} UTC.',
  'halt.body': 'Les robots sont arrêtés et ne peuvent pas trader.',
  'halt.reason': 'Raison : {reason}.',
  'halt.who': 'Une personne avec un accès Pro doit relancer le trading.',
  'common.cancel': 'Annuler',
  'common.close': 'Fermer',
  'common.save': 'Enregistrer',
  'common.next': 'Suivant',
  'common.back': 'Retour',
  'common.loading': 'Chargement…',
  'common.tryAgain': 'Réessayer',
  'common.error': 'Un problème est survenu. Réessayez.',
  'common.simulated': 'Prix simulés. Argent d’entraînement uniquement.',

  // ---- Home ----
  'home.title': 'Accueil',
  'home.balance.title': 'Votre compte d’entraînement',
  'home.balance.change': '{amount} ({pct} %) depuis vos débuts · {since}',
  'home.since.today': 'aujourd’hui',
  'home.since.days': '{n} jours',
  'home.since.week': '1 semaine',
  'home.since.weeks': '{n} semaines',
  'home.chart.label': 'Votre solde dans le temps',
  'home.dip':
    'Pire baisse jusqu’ici : **{amount} ({pct} %)**. Les baisses sont normales ; prévoyez-les.',
  'home.dip.none': 'Aucune baisse jusqu’ici. Les baisses sont normales ; prévoyez-les.',
  'home.own.title': 'Ce que vous possédez',
  'home.own.empty': 'Rien pour l’instant. Vos trades s’afficheront ici.',
  'home.own.gainUp': 'Vous gagnez si ça monte',
  'home.own.gainDown': 'Vous gagnez si ça baisse',
  'home.own.paused': 'Prix en pause',
  'home.own.close': 'Fermer',
  'home.own.closeAria': 'Fermer votre trade {name}',
  'home.own.closeTitle': 'Fermer votre trade {name} ?',
  'home.own.closeBody': 'Nous le fermons maintenant au prix du marché. Le résultat est définitif.',
  'home.own.closeConfirm': 'Fermer le trade',
  'home.own.closed': 'Trade fermé.',

  // ---- Limits ----
  'limits.title': 'Vos limites',
  'limits.subtitle': 'C’est vous qui les fixez. En desserrer une prend 24 heures.',
  'limits.today': 'Perdu aujourd’hui',
  'limits.month': 'Perdu ce mois-ci',
  'limits.of': '{used} sur {limit}',
  'limits.notSet': 'non fixée',
  'limits.pending.dailyLossLimit': 'Votre limite du jour passe à {value} le {date}.',
  'limits.pending.monthlyLossLimit': 'Votre limite du mois passe à {value} le {date}.',
  'limits.pending.noviceMaxLeverage': 'L’emprunt commence le {date}.',
  'limits.pending.other': 'Une limite augmente le {date}.',
  'limits.borrowing': '[Argent emprunté (effet de levier)](term:leverage) : **{state}**',
  'limits.borrow.off': 'Désactivé',
  'limits.borrow.on': 'Activé, jusqu’à {max}× votre argent',
  'limits.borrow.pending': 'Désactivé jusqu’au {date}',
  'limits.unlock': 'réussissez un test de 5 questions pour le débloquer',
  'limits.edit': 'Modifier mes limites',
  'limits.editTitle': 'Modifier vos limites',
  'limits.editBody':
    'Une limite plus basse s’applique tout de suite. Une limite plus haute s’applique dans 24 heures.',
  'limits.daily': 'Perte maximale par jour',
  'limits.monthly': 'Perte maximale par mois',
  'limits.saved': 'Enregistré.',
  'limits.savedPending': 'Enregistré. Une limite plus haute s’applique dans 24 heures.',
  'limits.invalid': 'Saisissez un montant supérieur à zéro.',
  'limits.monthlyLow': 'Votre limite du mois doit être au moins égale à votre limite du jour.',
  'borrow.title': 'Emprunt',
  'borrow.off': 'L’emprunt est désactivé.',
  'borrow.needCheck': 'Pour demander l’emprunt, réussissez d’abord le test de 5 questions.',
  'borrow.takeCheck': 'Faire le test',
  'borrow.askBody':
    'L’emprunt rend les gains et les pertes plus grands. Si vous le demandez maintenant, il commence dans 24 heures, jusqu’à {max}× votre argent. Vous pouvez l’arrêter à tout moment.',
  'borrow.ask': 'Demander l’activation de l’emprunt',
  'borrow.pending': 'L’emprunt commence le {date}. Vous pouvez encore l’annuler.',
  'borrow.on': 'L’emprunt est activé, jusqu’à {max}× votre argent.',
  'borrow.turnOff': 'Désactiver l’emprunt',

  // ---- Cooling-off ----
  'cool.title': 'C’est le moment de faire une pause',
  'cool.losing_trades': 'Vous avez eu {n} trades perdants aujourd’hui.',
  'cool.daily_loss_pct': 'La perte du jour est de {pct} % de votre solde.',
  'cool.daily_loss_limit': 'Vous avez atteint votre limite de perte du jour.',
  'cool.body':
    'Les nouveaux trades rouvrent demain, {time}. Vous pouvez toujours fermer vos trades. Les pertes sont normales. Une courte pause aide à décider calmement.',
  'cool.learn': 'Lire : les pertes sont normales',

  // ---- What's moving (goal 07B card on Home) ----
  'moving.title': 'Ce qui bouge et pourquoi',
  'moving.loading': 'Chargement…',
  'moving.failed': 'Ce n’est pas disponible pour le moment.',
  'moving.empty': 'Rien ne ressort sur le marché d’entraînement pour le moment.',
  'moving.up': '{name} a monté plus que d’habitude. C’est un grand mouvement pour lui.',
  'moving.down': '{name} a baissé plus que d’habitude. C’est un grand mouvement pour lui.',
  'moving.choppy': '{name} monte et descend beaucoup. Les prix peuvent sauter vite en ce moment.',
  'moving.turned':
    '{name} a changé de sens. Il est reparti dans l’autre sens après un grand mouvement.',
  'moving.quiet': '{name} est resté dans une petite zone. Il a peu bougé.',
  'moving.news': 'Dans l’actualité : « {title} » ({source}).',
  'moving.source': 'Source',
  'moving.odds':
    'Par le passé, des prévisions comme celle-ci se sont réalisées environ {per100} fois sur 100 ({n} cas).',
  'moving.note':
    'Marché d’entraînement avec des prix SIMULÉS. Cela montre ce qui a bougé, pas quoi faire.',
  'moving.disclaimer': 'Ceci n’est pas un conseil en investissement.',

  // ---- Explain this to me (goal 07 copilot, novice mode) ----
  'explain.button': 'Expliquez-moi ceci',
  'explain.busy': 'Explication en cours…',
  'explain.failed': 'L’explication n’est pas disponible pour le moment.',
  'explain.english': 'La réponse est en anglais pour le moment.',

  // ---- Make a trade ----
  'trade.title': 'Faire un trade',
  'trade.subtitle':
    'Trois étapes. Vous verrez la perte maximale avant que quoi que ce soit ne se passe.',
  'trade.step1': '1 · Que voulez-vous trader ?',
  'trade.closed': 'Fermé',
  'trade.more': 'Plus de marchés ({n})',
  'trade.fewer': 'Moins de marchés',
  'trade.closedNote': '{name} : le marché est fermé. Il ouvre {when}.',
  'trade.step2': '2 · Que va-t-il se passer selon vous ?',
  'trade.up': 'Ça va monter (acheter)',
  'trade.down': 'Ça va baisser (vendre)',
  'trade.step3': '3 · Combien ? (en {ccy})',
  'trade.min': 'Le montant minimum pour {name} est {amount}.',
  'trade.safety.up':
    'Filet de sécurité : vendre automatiquement si le prix va de {pct} % contre moi',
  'trade.safety.down':
    'Filet de sécurité : racheter automatiquement si le prix va de {pct} % contre moi',
  'trade.most': 'Perte maximale',
  'trade.fees':
    'Dont {fees} de frais. Sur un marché très rapide, la perte peut être un peu plus grande.',
  'trade.pick': 'Choisissez quoi, dans quel sens et combien. Vous verrez alors la perte maximale.',
  'trade.working': 'Calcul en cours…',
  'trade.noPrice':
    'Il n’y a pas de prix pour l’instant, donc pas de calcul de la perte maximale. Réessayez bientôt.',
  'trade.review': 'Vérifier mon trade',
  'trade.blocked': 'Ce trade ne peut pas passer pour l’instant :',
  'review.title': 'Vérifiez votre trade',
  'review.up': 'Vous pensez que {name} va monter. Vous mettez {amount}.',
  'review.down': 'Vous pensez que {name} va baisser. Vous mettez {amount}.',
  'review.loss': 'Si le filet de sécurité est touché, vous perdez environ **{loss}**.',
  'review.gain': 'Si le prix bouge d’autant en votre faveur, vous gagnez environ **{gain}**.',
  'review.fees': 'Les frais de {fees} sont déjà inclus dans ces chiffres.',
  'review.gap':
    'Sur un marché très rapide, le prix peut sauter au-delà du filet de sécurité, et la perte peut être un peu plus grande.',
  'review.check': 'Je comprends que je pourrais perdre jusqu’à {loss}.',
  'review.confirm': 'Confirmer le trade',
  'review.back': 'Revenir',
  'review.done': 'C’est fait. Votre trade est ouvert.',
  'review.failed': 'Le trade n’est pas passé.',
  'review.practice': 'Argent d’entraînement. Rien de réel n’est en jeu.',

  // ---- Server risk reasons ----
  'risk.MAX_ORDER_NOTIONAL': 'Ce trade dépasse le maximum autorisé pour un trade.',
  'risk.FAT_FINGER': 'Un prix de ce trade est loin du prix du marché. Vérifiez-le.',
  'risk.MAX_POSITION': 'Vous en détiendriez plus que le maximum autorisé.',
  'risk.MAX_LEVERAGE': 'Cela emprunterait plus que le maximum autorisé.',
  'risk.INSUFFICIENT_MARGIN': 'Votre solde ne suffit pas pour ce trade.',
  'risk.DAILY_LOSS_LIMIT':
    'Vous avez atteint votre limite de perte du jour. Vous pouvez toujours fermer vos trades.',
  'risk.WEEKLY_LOSS_LIMIT':
    'Vous avez atteint votre limite de perte de la semaine. Vous pouvez toujours fermer vos trades.',
  'risk.MONTHLY_LOSS_LIMIT':
    'Vous avez atteint votre limite de perte du mois. Vous pouvez toujours fermer vos trades.',
  'risk.ORDER_RATE_LIMIT': 'Trop de trades en une minute. Patientez un instant.',
  'risk.SESSION_CLOSED': 'Le marché est fermé pour l’instant.',
  'risk.INSTRUMENT_NOT_TRADABLE': 'Ceci ne peut pas être tradé pour l’instant.',
  'risk.NO_MARKET_DATA': 'Il n’y a pas de prix pour l’instant.',
  'risk.MARKET_DATA_STALE': 'Le prix n’est pas à jour. Attendez un nouveau prix.',
  'risk.FEED_NOT_OK': 'Les prix arrivent mal. Réessayez bientôt.',
  'risk.FX_RATE_UNAVAILABLE': 'Pas de taux de change à jour pour votre monnaie pour l’instant.',
  'risk.NOVICE_ORDER_TYPE':
    'En vue simple, chaque trade se fait au prix du marché, avec un filet de sécurité.',
  'risk.NOVICE_STOP_REQUIRED': 'Chaque trade a besoin d’un filet de sécurité.',
  'risk.NOVICE_LEVERAGE':
    'Ce trade demanderait de l’argent emprunté. L’emprunt est désactivé. Choisissez un montant plus petit.',
  'risk.NOVICE_COOLING_OFF':
    'C’est le moment de faire une pause. Les nouveaux trades rouvrent demain. Vous pouvez toujours fermer vos trades.',
  'risk.DISCLOSURE_NOT_ACKNOWLEDGED':
    'Lisez et confirmez d’abord l’avertissement sur les risques. Ensuite, vous pourrez trader. Vous pouvez toujours fermer vos trades.',
  'risk.REDUCE_ONLY_WOULD_INCREASE': 'Cet ordre peut seulement réduire un trade.',
  'risk.POST_ONLY_WOULD_TAKE': 'Cet ordre s’exécuterait tout de suite, ce qui n’est pas permis.',
  'risk.STOP_LOSS_WRONG_SIDE': 'Le filet de sécurité est du mauvais côté du prix.',
  'risk.TAKE_PROFIT_WRONG_SIDE': 'L’objectif de gain est du mauvais côté du prix.',
  'risk.TRADING_HALTED': 'Le trading est arrêté par le bouton d’arrêt.',
  'risk.FOK_INSUFFICIENT_DEPTH': 'Le marché ne peut pas tout exécuter d’un coup.',
  'risk.default': 'Ce trade ne peut pas passer pour l’instant.',

  // ---- Onboarding ----
  'onb.title': 'Bienvenue sur Kora',
  'onb.progress': 'Étape {n} sur {total}',
  'onb.account': 'Votre compte d’entraînement est prêt, avec {amount} d’argent d’entraînement.',
  'onb.s1.title': 'Ce qu’est le trading',
  'onb.s1.body':
    'Vous achetez quand vous pensez que le prix va monter. Vous vendez quand vous pensez qu’il va baisser. Si vous avez raison, vous gagnez. Si vous avez tort, vous perdez.',
  'onb.s2.title': 'Écart et frais',
  'onb.s2.body':
    'Chaque trade a un petit coût. Le prix d’achat est un peu plus haut que le prix de vente. Cette différence est l’[écart](term:spread). Certains trades ont aussi des [frais](term:fees). Vous payez ces coûts même quand vous gagnez.',
  'onb.s3.title': 'Votre filet de sécurité',
  'onb.s3.body':
    'Un [filet de sécurité](term:safety-net) ferme un trade pour vous si le prix va trop loin contre vous. Chaque trade ici en a un. Il limite votre perte. Sur un marché très rapide, le prix peut sauter au-delà, et la perte peut être un peu plus grande.',
  'onb.s4.title': 'L’emprunt',
  'onb.s4.body':
    'Certaines applis vous laissent [emprunter](term:leverage) pour faire de plus gros trades. Les gains et les pertes deviennent alors plus grands. L’emprunt est désactivé pour vous. Vous pourrez le demander plus tard, après un court test et une attente de 24 heures.',
  'onb.s5.title': 'Les pertes sont normales',
  'onb.s5.body':
    'Même les bons traders perdent souvent. L’important est qu’aucune perte ne vous fasse trop de mal. Fixez vos limites maintenant, pendant que vous êtes calme. Si vous en atteignez une, les nouveaux trades s’arrêtent pour la journée.',
  'onb.d.title': 'Lisez ceci d’abord',
  'onb.d.version': 'Version {version}',
  'onb.d.confirm': 'J’accepte, continuer',
  'onb.d.stale': 'Ce texte vient de changer. Merci de le relire.',
  'onb.l.title': 'Fixez vos limites de perte',
  'onb.l.body':
    'Une [limite de perte](term:loss-limit) arrête les nouveaux trades quand vous avez perdu ce montant. Nous suggérons {dailyPct} % de votre solde par jour et {monthlyPct} % par mois. Vous pouvez les baisser à tout moment. Les augmenter prend 24 heures.',
  'onb.l.suggested': 'Suggéré : {amount}',
  'onb.l.finish': 'Commencer avec l’argent d’entraînement',

  // ---- Auto-invest ----
  'ai.title': 'Robots',
  'ai.card.subtitle':
    'Des robots prêts à l’emploi. Essayez-les d’abord avec de l’argent d’entraînement.',
  'ai.card.more': 'Voir tous les robots',
  'ai.intro':
    'Des [robots](term:robot) prêts à l’emploi qui tradent pour vous avec de l’argent d’entraînement. Commencez petit. Vous pouvez les mettre en pause à tout moment.',
  'ai.risk': 'Niveau de risque {n} sur 5',
  'ai.riskWhy': 'Pourquoi ce niveau',
  'ai.promise': 'Les résultats passés ne sont pas une promesse de résultats futurs.',
  'ai.factor.calm_markets': 'Il trade de grandes devises, qui bougent d’habitude lentement.',
  'ai.factor.mixed_markets':
    'Il trade des marchés comme l’or ou les actions, qui peuvent bouger davantage.',
  'ai.factor.crypto_markets':
    'Il trade des cryptos, qui peuvent beaucoup varier en quelques heures.',
  'ai.factor.single_market': 'Il ne trade qu’un seul marché, donc le risque n’est pas réparti.',
  'ai.factor.wide_safety_net':
    'Son filet de sécurité est large, donc chaque perte peut être plus grande.',
  'ai.factor.small_amounts': 'Il ne met qu’une petite partie de l’argent dans chaque trade.',
  'ai.t.trend-x.name': 'Tendance Stable',
  'ai.t.trend-x.summary': 'Suit les tendances longues des grandes devises et de l’or.',
  'ai.t.meanrev-gold.name': 'Équilibre Or',
  'ai.t.meanrev-gold.summary': 'Achète l’or après une baisse, avec de petits montants.',
  'ai.t.breakout-crypto.name': 'Cassure Crypto',
  'ai.t.breakout-crypto.summary':
    'Achète du bitcoin ou de l’ether quand le prix sort de sa zone, avec moins d’argent quand les prix varient plus.',
  'ai.results.title': '[Test sur des prix passés](term:past-results) qu’il n’a pas appris',
  'ai.results.none': 'Pas encore de résultats de test.',
  'ai.results.line': 'Résultat {ret} % · pire baisse {dip} % · {n} trades en {days} jours',
  'ai.mine.running': 'En marche avec de l’argent d’entraînement',
  'ai.mine.paused': 'En pause',
  'ai.mine.line': '{amount} investis · résultat jusqu’ici {pnl}',
  'ai.start': 'Essayer avec l’argent d’entraînement',
  'ai.amount': 'Combien d’argent d’entraînement ?',
  'ai.amountHint': 'Entre {min} et {max}.',
  'ai.confirm': 'Lancer le robot',
  'ai.started': 'Robot lancé avec de l’argent d’entraînement.',
  'ai.pause': 'Pause',
  'ai.resume': 'Relancer',
  'ai.live': 'Argent réel ?',
  'ai.liveTitle': 'L’argent réel n’est pas encore disponible',
  'ai.liveBody': 'Avant qu’un robot utilise de l’argent réel, tout ceci doit être fait :',
  'ai.live.knowledge_check': 'Vous avez réussi le test de 5 questions.',
  'ai.live.promotion_rules': 'Le robot a respecté les règles des robots et un relecteur a validé.',
  'ai.live.live_trading_enabled': 'Kora a activé le trading en argent réel.',
  'ai.err.onboarding_required': 'Terminez d’abord la courte introduction.',
  'ai.err.amount_out_of_range': 'Choisissez un montant entre {min} et {max}.',
  'ai.err.already_added': 'Vous utilisez déjà ce robot.',
  'ai.err.cooling_off': 'C’est le moment de faire une pause. Les robots pourront repartir demain.',
  'ai.err.trading_halted': 'Le trading est arrêté. Relancez d’abord le trading.',

  // ---- Learn ----
  'learn.title': 'Apprendre',
  'learn.intro': 'Des leçons courtes et simples. Chacune prend environ 2 minutes.',
  'learn.lessons': 'Leçons',
  'learn.glossary': 'Les mots que nous utilisons',
  'learn.minutes': 'Lecture de 2 minutes',
  'learn.all': 'Toutes les leçons',
  'learn.card.title': 'Apprendre en 2 minutes',
  'learn.card.spread':
    '[Écart](term:spread) : la petite différence entre le prix d’achat et le prix de vente. C’est un coût payé à chaque trade.',
  'learn.card.stop':
    '[Stop (filet de sécurité)](term:safety-net) : une vente automatique qui limite ce que vous pouvez perdre.',
  'learn.card.more': 'Plus de leçons',
  'learn.check.cta': 'Faire le test de 5 questions',
  'lesson.trading.title': 'Ce qu’est le trading',
  'lesson.trading.summary': 'Acheter, vendre, et pourquoi les prix bougent.',
  'lesson.trading.p1':
    'Un prix monte quand plus de gens veulent acheter. Il baisse quand plus de gens veulent vendre.',
  'lesson.trading.p2':
    'Vous achetez quand vous pensez que le prix va monter. Vous vendez quand vous pensez qu’il va baisser.',
  'lesson.trading.p3':
    'Personne ne sait ce que fera un prix ensuite. Même les experts se trompent souvent.',
  'lesson.trading.p4':
    'C’est pourquoi chaque trade ici montre la perte maximale avant que vous confirmiez.',
  'lesson.costs.title': 'Écart et frais',
  'lesson.costs.summary': 'Les coûts payés à chaque trade, gagnant ou perdant.',
  'lesson.costs.p1':
    'Il y a deux prix : un pour acheter et un pour vendre. Le prix d’achat est un peu plus haut.',
  'lesson.costs.p2':
    'La différence entre les deux est l’[écart](term:spread). Vous le payez à chaque trade.',
  'lesson.costs.p3':
    'Certains marchés ont aussi des [frais](term:fees). Nous les montrons dans votre monnaie avant que vous confirmiez.',
  'lesson.costs.p4':
    'Les petits coûts s’additionnent. Beaucoup de petits trades coûtent plus que quelques gros.',
  'lesson.safety-net.title': 'Votre filet de sécurité',
  'lesson.safety-net.summary':
    'Comment un filet de sécurité limite une perte, et quand il ne peut pas.',
  'lesson.safety-net.p1':
    'Un [filet de sécurité](term:safety-net) est un prix que vous fixez avant de trader.',
  'lesson.safety-net.p2':
    'Si le prix l’atteint, le trade se ferme pour vous. Cela limite la perte.',
  'lesson.safety-net.p3':
    'Sur un marché très rapide, le prix peut sauter au-delà. La perte est alors un peu plus grande.',
  'lesson.safety-net.p4':
    'Un filet plus proche donne des pertes plus petites, mais il est touché plus souvent.',
  'lesson.borrowing.title': 'L’emprunt (effet de levier)',
  'lesson.borrowing.summary': 'Pourquoi l’argent emprunté rend les pertes plus grandes.',
  'lesson.borrowing.p1':
    'Avec l’[emprunt](term:leverage), vous tradez avec plus d’argent que vous n’en avez.',
  'lesson.borrowing.p2':
    'Si vous empruntez pour un trade deux fois plus gros, une baisse de 10 % vous coûte 20 % de votre argent.',
  'lesson.borrowing.p3':
    'L’emprunt est désactivé pour vous. Vous pouvez le demander après le test de 5 questions.',
  'lesson.borrowing.p4':
    'Même alors, il ne commence qu’après 24 heures, et vous pouvez l’arrêter à tout moment.',
  'lesson.losses.title': 'Les pertes sont normales',
  'lesson.losses.summary': 'Comment perdre peu et continuer.',
  'lesson.losses.p1':
    'Les trades perdants font partie du trading. Même les bons traders perdent souvent.',
  'lesson.losses.p2':
    'Gardez chaque perte petite, pour qu’un mauvais trade ne fasse pas trop de mal.',
  'lesson.losses.p3':
    'Vos [limites de perte](term:loss-limit) arrêtent les nouveaux trades pour la journée quand vous les atteignez.',
  'lesson.losses.p4':
    'Après trois trades perdants dans la journée, nous proposons une pause jusqu’au lendemain. C’est la règle de [pause](term:cooling-off).',
  'term.spread.name': 'Écart',
  'term.spread.meaning':
    'La petite différence entre le prix d’achat et le prix de vente. Vous la payez à chaque trade.',
  'term.fees.name': 'Frais',
  'term.fees.meaning':
    'Un montant payé pour passer un trade. Nous le montrons dans votre monnaie avant que vous confirmiez.',
  'term.costs.name': 'Coûts',
  'term.costs.meaning':
    'Ce que chaque trade vous coûte, gagnant ou perdant : la petite différence entre les prix d’achat et de vente, plus les frais.',
  'term.safety-net.name': 'Filet de sécurité (stop)',
  'term.safety-net.meaning':
    'Une vente automatique qui limite ce qu’un trade peut perdre. Sur un marché très rapide, le prix peut sauter au-delà, et la perte peut être un peu plus grande.',
  'term.leverage.name': 'Emprunt (effet de levier)',
  'term.leverage.meaning':
    'Trader avec plus d’argent que vous n’en avez. Les gains et les pertes deviennent plus grands. Il est désactivé pour vous.',
  'term.loss-limit.name': 'Limite de perte',
  'term.loss-limit.meaning':
    'Le maximum que vous voulez perdre en un jour ou un mois. Quand vous l’atteignez, les nouveaux trades s’arrêtent.',
  'term.cooling-off.name': 'Pause',
  'term.cooling-off.meaning':
    'Une pause jusqu’au lendemain après trois trades perdants dans la journée ou une grosse perte en un jour.',
  'term.practice-money.name': 'Argent d’entraînement',
  'term.practice-money.meaning':
    'De l’argent fictif pour apprendre. Les prix bougent comme un vrai marché, mais rien de réel n’est en jeu.',
  'term.robot.name': 'Robot',
  'term.robot.meaning':
    'Un ensemble de règles fixes qui passe des trades pour vous. Vous pouvez le mettre en pause à tout moment.',
  'term.past-results.name': 'Test sur des prix passés',
  'term.past-results.meaning':
    'Nous faisons tourner un robot sur d’anciens prix qu’il n’a pas appris, pour voir ce qu’il aurait donné. Ce n’est pas une promesse.',
  'term.dip.name': 'Baisse',
  'term.dip.meaning': 'Une chute de votre solde depuis son plus haut niveau jusqu’ici.',
  'term.simulation.name': 'Simulation',
  'term.simulation.meaning':
    'Nous jouons 10 000 années inventées de trading avec vos choix, pour voir l’éventail de ce qui pourrait arriver. Rien de tout cela n’est de l’argent réel ni une vraie prévision.',
  'term.range.name': 'Zone probable',
  'term.range.meaning':
    'La zone ombrée du graphique. La plupart des années inventées (9 sur 10) sont restées dedans.',

  // ---- Knowledge check ----
  'kc.title': 'Test de 5 questions',
  'kc.intro':
    'Cinq courtes questions sur l’emprunt et les robots. Répondez juste à 4 pour débloquer l’étape suivante.',
  'kc.simulated': 'Questions d’entraînement. Notre équipe conformité va les relire.',
  'kc.submit': 'Vérifier mes réponses',
  'kc.answerAll': 'Répondez d’abord aux cinq questions.',
  'kc.passed': 'Réussi avec {pct} %.',
  'kc.passedNext':
    'Vous pouvez maintenant demander l’emprunt dans vos limites. Il commence 24 heures après votre demande.',
  'kc.failed': 'Vous avez {pct} %. Il faut {pass} %.',
  'kc.review': 'À revoir :',
  'kc.cooldown': 'Vous pourrez réessayer après {time}.',
  'kc.already': 'Vous avez déjà réussi ce test.',
  'kc.q.borrowing.prompt':
    'Vous empruntez pour que votre trade soit deux fois plus gros que votre argent. Le prix baisse de 10 %. Environ combien de votre propre argent perdez-vous ?',
  'kc.q.borrowing.a': 'Environ 10 %.',
  'kc.q.borrowing.b': 'Environ 20 %.',
  'kc.q.borrowing.c': 'Rien, l’argent emprunté supporte la perte.',
  'kc.q.safety_net.prompt':
    'Votre filet de sécurité est 3 % sous votre prix d’achat. Le marché ouvre 8 % plus bas après le week-end. Que se passe-t-il le plus probablement ?',
  'kc.q.safety_net.a': 'Le trade se ferme à exactement 3 % de baisse.',
  'kc.q.safety_net.b':
    'Le trade se ferme vers 8 % de baisse, car le prix a sauté au-delà du filet.',
  'kc.q.safety_net.c': 'Le trade reste ouvert jusqu’à ce que le prix remonte.',
  'kc.q.fees.prompt':
    'Vous achetez et revendez tout de suite au même prix de marché. Que se passe-t-il ?',
  'kc.q.fees.a': 'J’ai la même somme qu’avant.',
  'kc.q.fees.b': 'J’ai un peu moins, à cause de l’écart et des frais.',
  'kc.q.fees.c': 'J’ai un peu plus.',
  'kc.q.robot_results.prompt':
    'Un robot a gagné de l’argent dans un test sur des prix passés. Qu’est-ce que cela vous dit ?',
  'kc.q.robot_results.a': 'Il gagnera de l’argent à partir de maintenant.',
  'kc.q.robot_results.b':
    'Il a marché sur ces prix passés. Il peut quand même perdre de l’argent à l’avenir.',
  'kc.q.robot_results.c': 'Il ne peut pas perdre plus que ce qu’il a gagné dans le test.',
  'kc.q.losing_streak.prompt':
    'Vous avez perdu trois trades de suite aujourd’hui. Quelle est l’étape la plus sûre ?',
  'kc.q.losing_streak.a': 'Faire une pause et regarder ce qui s’est passé.',
  'kc.q.losing_streak.b': 'Trader plus gros pour vite tout regagner.',
  'kc.q.losing_streak.c': 'Retirer le filet de sécurité pour laisser plus de place aux trades.',
  'kc.topic.Borrowing (leverage)': 'L’emprunt (effet de levier)',
  'kc.topic.Safety net': 'Le filet de sécurité',
  'kc.topic.Spread and fees': 'Écart et frais',
  'kc.topic.Robot results': 'Les résultats des robots',
  'kc.topic.Losses are normal': 'Les pertes sont normales',

  // ---- Practice ----
  'practice.formTitle': 'S’entraîner : à quoi pourrait ressembler une année de trading ?',
  'practice.formIntro':
    'Répondez à trois questions. Nous jouons une année de trading d’entraînement des milliers de fois et vous montrons l’éventail des résultats.',
  'practice.amount': '1 · Combien d’argent d’entraînement ? (en dollars)',
  'practice.quick': 'Montants rapides',
  'practice.often': '2 · À quelle fréquence tradriez-vous ?',
  'practice.careful': '3 · À quel point seriez-vous prudent ?',
  'practice.often.rarely': 'Deux ou trois fois par mois',
  'practice.often.rarely.hint': 'environ 2 trades par mois',
  'practice.often.weekly': 'Une ou deux fois par semaine',
  'practice.often.weekly.hint': 'environ 6 trades par mois',
  'practice.often.daily': 'Presque tous les jours',
  'practice.often.daily.hint': 'environ 20 trades par mois',
  'practice.careful.very': 'Très prudent',
  'practice.careful.very.hint': 'chaque trade peut perdre au plus 0,50 $ sur 100 $',
  'practice.careful.balanced': 'Entre les deux',
  'practice.careful.balanced.hint': 'chaque trade peut perdre au plus 1 $ sur 100 $',
  'practice.careful.bold': 'Audacieux',
  'practice.careful.bold.hint': 'chaque trade peut perdre jusqu’à 3 $ sur 100 $',
  'practice.run': 'Montrez-moi une année d’entraînement',
  'practice.again': 'Montrez-moi encore',
  'practice.working': 'Calcul en cours…',
  'practice.errorTitle': 'Rien n’a été calculé.',
  'practice.error':
    'Impossible de lancer l’année d’entraînement pour l’instant. Réessayez dans un moment.',
  'practice.resultTitle': 'Votre année d’entraînement',
  'practice.notPromise': 'Ceci est une [simulation](term:simulation), pas une promesse.',
  'practice.good': 'Bonne année',
  'practice.good.explain': 'Seule 1 année d’entraînement sur 20 a fini plus haut.',
  'practice.typical': 'Année typique',
  'practice.typical.explain':
    'La moitié des années d’entraînement a fini au-dessus, la moitié en dessous.',
  'practice.bad': 'Mauvaise année',
  'practice.bad.explain': 'Seule 1 année d’entraînement sur 20 a fini plus bas.',
  'practice.up': '▲ hausse',
  'practice.down': '▼ baisse',
  'practice.range':
    'La zone ombrée est la [zone probable](term:range). La ligne foncée est le parcours typique, et la ligne en tirets est votre point de départ.',
  'practice.chartTitle': 'Zone probable de votre argent d’entraînement sur 12 mois',
  'practice.now': 'Maintenant',
  'practice.chartSummary':
    '{title}. Après {months} mois : résultat du milieu {mid}, 9 années inventées sur 10 entre {low} et {high} ; départ {start}.',
  'practice.watermark': 'SIMULÉ',
  'practice.month': 'Mois {n}',
  'practice.howTitle': 'Comment nous avons calculé',
  'practice.how':
    'Nous supposons aucun talent particulier : la moitié des trades gagnent, un gain a la même taille qu’une perte, chaque trade a des [coûts](term:costs), et de temps en temps un prix saute au-delà de votre [filet de sécurité](term:safety-net). Les résultats passés ne sont pas une promesse de résultats futurs.',
  'practice.disclosure':
    'Le vrai trading est plus dur : {pct} % des comptes de particuliers perdent de l’argent avec ce fournisseur.',
  'practice.empty':
    'Choisissez vos réponses et appuyez sur « Montrez-moi une année d’entraînement ». Rien ici n’utilise d’argent réel.',
  'practice.words': 'Mots utilisés ici',
  'practice.save': 'Enregistrer ce plan',
  'practice.saveName': 'Nom de ce plan',
  'practice.saved': 'Plan enregistré.',
  'practice.savedTitle': 'Vos plans enregistrés',
  'practice.load': 'Utiliser',
  'practice.delete': 'Supprimer',
  'practice.deleteAria': 'Supprimer le plan {name}',
  'practice.loadAria': 'Utiliser le plan {name}',
  'practice.nameTaken': 'Vous avez déjà un plan avec ce nom.',

  // ---- Settings (novice) ----
  'settings.lang.title': 'Langue',
  'settings.colours.title': 'Couleurs de hausse et de baisse',
  'settings.colours.hint': 'Le sens s’affiche aussi avec ▲▼ et + ou −.',
  'settings.colours.blue_orange':
    'Bleu pour la hausse, orange pour la baisse (adapté au daltonisme)',
  'settings.colours.green_red': 'Vert pour la hausse, rouge pour la baisse',
  'settings.colours.red_up_asia': 'Rouge pour la hausse, vert pour la baisse',
  'settings.saved': 'Enregistré.',
  'settings.twoStep.title': 'Connexion en deux étapes (facultative)',
  'settings.twoStep.body':
    'Ajoutez un code venant d’une appli sur votre téléphone à chaque connexion. Votre compte est plus sûr.',
  'settings.twoStep.start': 'Activer la connexion en deux étapes',
  'settings.twoStep.scan':
    'Scannez ce code avec une appli d’authentification. Puis tapez le code à 6 chiffres affiché.',
  'settings.twoStep.qr': 'Code QR pour votre appli d’authentification',
  'settings.twoStep.secret': 'Ou tapez cette clé : {secret}',
  'settings.twoStep.code': 'Code à 6 chiffres',
  'settings.twoStep.verify': 'Activer',
  'settings.twoStep.on': 'La connexion en deux étapes est activée.',
  'settings.twoStep.bad': 'Ce code n’a pas marché. Essayez le plus récent.',
  'settings.twoStep.codesTitle': 'Gardez vos codes de secours',
  'settings.twoStep.codesBody':
    'Si vous perdez votre téléphone, chaque code permet de vous connecter une fois. Rangez-les en lieu sûr. Nous ne les montrons qu’une fois.',
  'settings.twoStep.codesDone': 'J’ai gardé mes codes',

  // ---- Offline shell ----
  'offline.title': 'Prix en pause',
  'offline.body':
    'Vous êtes hors ligne. Kora n’affiche aucun prix et ne passe aucun trade avant votre retour en ligne. Votre compte d’entraînement ne risque rien.',
  'offline.retry': 'Réessayer',

  // ---- Currencies ----
  'ccy.USD': 'dollars',
  'ccy.EUR': 'euros',
  'ccy.GBP': 'livres',
  'ccy.JPY': 'yens',
  'ccy.CHF': 'francs',
};
