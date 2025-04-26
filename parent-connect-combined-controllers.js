// controllers/auth.js
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../utils/email');

// [Auth and User functions unchanged for brevity...]

// Groupe parental basé sur intérêts communs ou problématiques
const Group = require('../models/Group');
const GroupPost = require('../models/GroupPost');
const GroupComment = require('../models/GroupComment');
const Notification = require('../models/Notification');
const Report = require('../models/Report');

// ------- GESTION DES GROUPES -------

// Créer un groupe
exports.createGroup = async (req, res, next) => {
  try {
    const { name, description, tags } = req.body;
    const group = new Group({
      name,
      description,
      tags,
      members: [req.user.userId],
      moderators: [req.user.userId] // Le créateur est automatiquement modérateur
    });
    await group.save();
    res.status(201).json({ message: 'Groupe créé', group });
  } catch (error) {
    next(error);
  }
};

// Rejoindre un groupe
exports.joinGroup = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: 'Groupe non trouvé' });

    if (!group.members.includes(req.user.userId)) {
      group.members.push(req.user.userId);
      await group.save();
      
      // Notifier les modérateurs du groupe
      if (group.moderators && group.moderators.length > 0) {
        const notifications = group.moderators.map(modId => {
          return new Notification({
            recipient: modId,
            type: 'group_join',
            content: `Un nouvel utilisateur a rejoint le groupe "${group.name}"`,
            reference: {
              type: 'group',
              id: group._id
            }
          });
        });
        
        await Notification.insertMany(notifications);
      }
    }
    res.status(200).json({ message: 'Vous avez rejoint le groupe', group });
  } catch (error) {
    next(error);
  }
};

// Quitter un groupe
exports.leaveGroup = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: 'Groupe non trouvé' });

    // Retirer l'utilisateur des membres
    group.members = group.members.filter(id => id.toString() !== req.user.userId);
    
    // Retirer l'utilisateur des modérateurs s'il y est
    if (group.moderators) {
      group.moderators = group.moderators.filter(id => id.toString() !== req.user.userId);
    }
    
    await group.save();
    res.status(200).json({ message: 'Vous avez quitté le groupe' });
  } catch (error) {
    next(error);
  }
};

// Recommandation de groupes
exports.getSuggestedGroups = async (req, res, next) => {
  try {
    const profile = await Profile.findOne({ user: req.user.userId });
    if (!profile) return res.status(404).json({ message: 'Profil non trouvé' });

    const keywords = [...(profile.interests || []), ...(profile.childNeeds || []), ...(profile.childAgeGroups || [])];

    const groups = await Group.find({ tags: { $in: keywords } }).limit(10);

    res.status(200).json(groups);
  } catch (error) {
    next(error);
  }
};

// ------- GESTION DES POSTS ET COMMENTAIRES -------

// Filtrer le contenu inapproprié
const filterInappropriateContent = (text) => {
  // Liste de mots inappropriés (à compléter selon vos besoins)
  const inappropriateWords = ['mot1', 'mot2', 'mot3'];
  
  let filteredText = text;
  inappropriateWords.forEach(word => {
    const regex = new RegExp(word, 'gi');
    filteredText = filteredText.replace(regex, '*'.repeat(word.length));
  });
  
  return filteredText;
};

// Middleware pour filtrer automatiquement le contenu
exports.contentFilterMiddleware = (req, res, next) => {
  if (req.body.content) {
    req.body.content = filterInappropriateContent(req.body.content);
  }
  
  if (req.body.text) {
    req.body.text = filterInappropriateContent(req.body.text);
  }
  
  next();
};

// Créer une publication dans un groupe
exports.createGroupPost = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { content } = req.body;
    
    // Vérifier que l'utilisateur est membre du groupe
    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: 'Groupe non trouvé' });
    if (!group.members.includes(req.user.userId)) {
      return res.status(403).json({ message: 'Vous devez être membre du groupe pour publier' });
    }
    
    // Appliquer le filtre automatique
    const filteredContent = filterInappropriateContent(content);
    
    const post = new GroupPost({ 
      group: groupId, 
      author: req.user.userId, 
      content: filteredContent 
    });
    
    await post.save();
    
    // Créer des notifications pour les membres du groupe
    await createPostNotification(post);
    
    res.status(201).json({ message: 'Publication créée', post });
  } catch (error) {
    next(error);
  }
};

// Récupérer les publications d'un groupe
exports.getGroupPosts = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const posts = await GroupPost.find({ group: groupId })
      .populate('author', 'firstName lastName')
      .sort({ createdAt: -1 });
    res.status(200).json(posts);
  } catch (error) {
    next(error);
  }
};

// Commenter une publication de groupe
exports.commentGroupPost = async (req, res, next) => {
  try {
    const { postId } = req.params;
    const { text } = req.body;
    
    // Vérifier que le post existe
    const post = await GroupPost.findById(postId).populate('group');
    if (!post) return res.status(404).json({ message: 'Publication non trouvée' });
    
    // Vérifier que l'utilisateur est membre du groupe
    const group = await Group.findById(post.group);
    if (!group.members.includes(req.user.userId)) {
      return res.status(403).json({ message: 'Vous devez être membre du groupe pour commenter' });
    }
    
    // Appliquer le filtre automatique
    const filteredText = filterInappropriateContent(text);
    
    const comment = new GroupComment({ 
      post: postId, 
      author: req.user.userId, 
      text: filteredText 
    });
    
    await comment.save();
    
    // Créer des notifications pour l'auteur du post et les autres commentateurs
    await createCommentNotification(comment);
    
    res.status(201).json({ message: 'Commentaire ajouté', comment });
  } catch (error) {
    next(error);
  }
};

// Récupérer les commentaires d'un post
exports.getGroupPostComments = async (req, res, next) => {
  try {
    const { postId } = req.params;
    const comments = await GroupComment.find({ post: postId })
      .populate('author', 'firstName lastName')
      .sort({ createdAt: 1 });
    res.status(200).json(comments);
  } catch (error) {
    next(error);
  }
};

// ------- SYSTÈME DE MODÉRATION -------

// Signaler une publication ou un commentaire
exports.reportContent = async (req, res, next) => {
  try {
    const { contentId, contentType, reason } = req.body;
    
    // Vérifier que le contenu existe
    const content = contentType === 'post' 
      ? await GroupPost.findById(contentId).populate('group')
      : await GroupComment.findById(contentId).populate('post');
    
    if (!content) {
      return res.status(404).json({ message: 'Contenu non trouvé' });
    }
    
    // Créer un nouveau rapport
    const report = new Report({
      reporter: req.user.userId,
      contentId,
      contentType,
      reason,
      status: 'pending'
    });
    
    await report.save();
    
    // Informer les modérateurs du groupe
    const groupId = contentType === 'post' ? content.group._id : content.post.group;
    const group = await Group.findById(groupId);
    
    // Créer une notification pour les modérateurs du groupe
    if (group.moderators && group.moderators.length > 0) {
      const moderationNotifications = group.moderators.map(modId => {
        return new Notification({
          recipient: modId,
          type: 'moderation_needed',
          content: `Un contenu a été signalé dans le groupe "${group.name}"`,
          reference: {
            type: 'report',
            id: report._id
          }
        });
      });
      
      await Notification.insertMany(moderationNotifications);
    }
    
    res.status(201).json({ message: 'Contenu signalé avec succès' });
  } catch (error) {
    next(error);
  }
};

// Traiter les signalements (pour les modérateurs)
exports.handleReport = async (req, res, next) => {
  try {
    const { reportId, action } = req.body; // action peut être 'approve' ou 'reject'
    
    const report = await Report.findById(reportId);
    if (!report) return res.status(404).json({ message: 'Signalement non trouvé' });
    
    // Vérifier que l'utilisateur est modérateur du groupe concerné
    const content = report.contentType === 'post' 
      ? await GroupPost.findById(report.contentId).populate('group')
      : await GroupComment.findById(report.contentId).populate('post');
    
    if (!content) {
      // Le contenu a peut-être déjà été supprimé
      report.status = 'approved';
      await report.save();
      return res.status(200).json({ message: 'Contenu déjà supprimé' });
    }
    
    const groupId = report.contentType === 'post' ? content.group._id : content.post.group;
    const group = await Group.findById(groupId);
    
    if (!group.moderators.includes(req.user.userId)) {
      return res.status(403).json({ message: 'Non autorisé' });
    }
    
    if (action === 'approve') {
      // Supprimer le contenu signalé
      if (report.contentType === 'post') {
        await GroupPost.findByIdAndDelete(report.contentId);
        // Supprimer également tous les commentaires associés
        await GroupComment.deleteMany({ post: report.contentId });
      } else {
        await GroupComment.findByIdAndDelete(report.contentId);
      }
      
      report.status = 'approved';
      
      // Notifier l'auteur du contenu
      const authorId = report.contentType === 'post' ? content.author : content.author;
      const newNotification = new Notification({
        recipient: authorId,
        type: 'content_removed',
        content: `Votre ${report.contentType === 'post' ? 'publication' : 'commentaire'} a été supprimé suite à un signalement`,
        reference: {
          type: report.contentType,
          id: report.contentId
        }
      });
      
      await newNotification.save();
    } else {
      report.status = 'rejected';
    }
    
    await report.save();
    
    res.status(200).json({ message: 'Signalement traité avec succès' });
  } catch (error) {
    next(error);
  }
};

// Ajouter un modérateur au groupe
exports.addModerator = async (req, res, next) => {
  try {
    const { groupId, userId } = req.body;
    
    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: 'Groupe non trouvé' });
    
    // Vérifier que l'utilisateur est le créateur du groupe ou un modérateur existant
    if (group.members[0].toString() !== req.user.userId && 
        (!group.moderators || !group.moderators.includes(req.user.userId))) {
      return res.status(403).json({ message: 'Non autorisé' });
    }
    
    // Vérifier que l'utilisateur à ajouter comme modérateur est membre du groupe
    if (!group.members.includes(userId)) {
      return res.status(400).json({ message: 'L\'utilisateur doit d\'abord être membre du groupe' });
    }
    
    // Ajouter l'utilisateur comme modérateur s'il ne l'est pas déjà
    if (!group.moderators) {
      group.moderators = [userId];
    } else if (!group.moderators.includes(userId)) {
      group.moderators.push(userId);
    }
    
    await group.save();
    
    // Notifier l'utilisateur qu'il est devenu modérateur
    const newNotification = new Notification({
      recipient: userId,
      type: 'moderator_role',
      content: `Vous êtes maintenant modérateur du groupe "${group.name}"`,
      reference: {
        type: 'group',
        id: group._id
      }
    });
    
    await newNotification.save();
    
    res.status(200).json({ message: 'Modérateur ajouté avec succès', group });
  } catch (error) {
    next(error);
  }
};

// Retirer un modérateur du groupe
exports.removeModerator = async (req, res, next) => {
  try {
    const { groupId, userId } = req.body;
    
    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ message: 'Groupe non trouvé' });
    
    // Vérifier que l'utilisateur est le créateur du groupe
    if (group.members[0].toString() !== req.user.userId) {
      return res.status(403).json({ message: 'Seul le créateur du groupe peut retirer des modérateurs' });
    }
    
    // Vérifier qu'on ne supprime pas le créateur comme modérateur
    if (userId === group.members[0].toString()) {
      return res.status(400).json({ message: 'Le créateur du groupe ne peut pas être retiré des modérateurs' });
    }
    
    // Retirer l'utilisateur des modérateurs
    if (group.moderators) {
      group.moderators = group.moderators.filter(id => id.toString() !== userId);
      await group.save();
      
      // Notifier l'utilisateur qu'il n'est plus modérateur
      const newNotification = new Notification({
        recipient: userId,
        type: 'moderator_removed',
        content: `Vous n'êtes plus modérateur du groupe "${group.name}"`,
        reference: {
          type: 'group',
          id: group._id
        }
      });
      
      await newNotification.save();
    }
    
    res.status(200).json({ message: 'Modérateur retiré avec succès', group });
  } catch (error) {
    next(error);
  }
};

// ------- SYSTÈME DE NOTIFICATIONS -------

// Créer une notification pour un nouveau post dans un groupe
const createPostNotification = async (post) => {
  try {
    const group = await Group.findById(post.group);
    
    // Pour tous les membres du groupe (sauf l'auteur du post)
    const notifications = group.members
      .filter(memberId => memberId.toString() !== post.author.toString())
      .map(memberId => {
        return new Notification({
          recipient: memberId,
          type: 'new_post',
          content: `Nouvelle publication dans le groupe "${group.name}"`,
          reference: {
            type: 'post',
            id: post._id
          }
        });
      });
    
    if (notifications.length > 0) {
      await Notification.insertMany(notifications);
    }
  } catch (error) {
    console.error('Erreur lors de la création des notifications:', error);
  }
};

// Créer une notification pour un nouveau commentaire
const createCommentNotification = async (comment) => {
  try {
    const post = await GroupPost.findById(comment.post);
    
    // Notifier l'auteur du post
    if (post.author.toString() !== comment.author.toString()) {
      const notification = new Notification({
        recipient: post.author,
        type: 'new_comment',
        content: 'Quelqu\'un a commenté votre publication',
        reference: {
          type: 'comment',
          id: comment._id
        }
      });
      
      await notification.save();
    }
    
    // Notifier les autres commentateurs (sans doublons)
    const otherComments = await GroupComment.find({ 
      post: comment.post,
      author: { $ne: comment.author }
    }).distinct('author');
    
    const uniqueAuthorIds = [...new Set(otherComments.map(id => id.toString()))];
    
    // Exclure l'auteur du post car il a déjà été notifié
    const commentatorsToNotify = uniqueAuthorIds.filter(id => 
      id !== post.author.toString() && id !== comment.author.toString()
    );
    
    const notifications = commentatorsToNotify.map(authorId => {
      return new Notification({
        recipient: authorId,
        type: 'new_comment',
        content: 'Nouvelle réponse dans une discussion où vous avez participé',
        reference: {
          type: 'comment',
          id: comment._id
        }
      });
    });
    
    if (notifications.length > 0) {
      await Notification.insertMany(notifications);
    }
  } catch (error) {
    console.error('Erreur lors de la création des notifications:', error);
  }
};

// Récupérer les notifications non lues
exports.getUnreadNotifications = async (req, res, next) => {
  try {
    const notifications = await Notification.find({ 
      recipient: req.user.userId,
      read: false
    }).sort({ createdAt: -1 });
    
    res.status(200).json(notifications);
  } catch (error) {
    next(error);
  }
};

// Récupérer toutes les notifications
exports.getAllNotifications = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    
    const notifications = await Notification.find({ 
      recipient: req.user.userId
    })
    .sort({ createdAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit);
    
    const count = await Notification.countDocuments({ recipient: req.user.userId });
    
    res.status(200).json({
      notifications,
      totalPages: Math.ceil(count / limit),
      currentPage: page,
      totalNotifications: count
    });
  } catch (error) {
    next(error);
  }
};

// Marquer une notification comme lue
exports.markNotificationAsRead = async (req, res, next) => {
  try {
    const { notificationId } = req.params;
    
    const notification = await Notification.findById(notificationId);
    if (!notification) return res.status(404).json({ message: 'Notification non trouvée' });
    
    // Vérifier que la notification appartient à l'utilisateur
    if (notification.recipient.toString() !== req.user.userId) {
      return res.status(403).json({ message: 'Non autorisé' });
    }
    
    notification.read = true;
    await notification.save();
    
    res.status(200).json({ message: 'Notification marquée comme lue' });
  } catch (error) {
    next(error);
  }
};

// Marquer toutes les notifications comme lues
exports.markAllNotificationsAsRead = async (req, res, next) => {
  try {
    await Notification.updateMany(
      { recipient: req.user.userId, read: false },
      { read: true }
    );
    
    res.status(200).json({ message: 'Toutes les notifications ont été marquées comme lues' });
  } catch (error) {
    next(error);
  }
};

// Supprimer une notification
exports.deleteNotification = async (req, res, next) => {
  try {
    const { notificationId } = req.params;
    
    const notification = await Notification.findById(notificationId);
    if (!notification) return res.status(404).json({ message: 'Notification non trouvée' });
    
    // Vérifier que la notification appartient à l'utilisateur
    if (notification.recipient.toString() !== req.user.userId) {
      return res.status(403).json({ message: 'Non autorisé' });
    }
    
    await Notification.findByIdAndDelete(notificationId);
    
    res.status(200).json({ message: 'Notification supprimée' });
  } catch (error) {
    next(error);
  }
};

// Obtenir le nombre de notifications non lues
exports.getUnreadNotificationCount = async (req, res, next) => {
  try {
    const count = await Notification.countDocuments({ 
      recipient: req.user.userId,
      read: false
    });
    
    res.status(200).json({ count });
  } catch (error) {
    next(error);
  }
};

// Modèles à créer pour supporter ces fonctionnalités

/*
// models/Notification.js
const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    required: true,
    enum: [
      'new_post', 
      'new_comment', 
      'group_invite', 
      'content_removed', 
      'moderator_role',
      'moderator_removed', 
      'moderation_needed',
      'group_join'
    ]
  },
  content: {
    type: String,
    required: true
  },
  read: {
    type: Boolean,
    default: false
  },
  reference: {
    type: {
      type: String,
      required: true,
      enum: ['post', 'comment', 'group', 'report']
    },
    id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true
    }
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Notification', notificationSchema);
*/

/*
// models/Report.js
const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  reporter: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  contentId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  contentType: {
    type: String,
    enum: ['post', 'comment'],
    required: true
  },
  reason: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Report', reportSchema);
*/

/*
// Dans models/Group.js, ajouter:
moderators: [{
  type: mongoose.Schema.Types.ObjectId,
  ref: 'User'
}]
*/
